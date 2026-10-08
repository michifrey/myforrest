'use strict';

/**
 * Species whose locations should not be public: finds are protected
 * automatically when Pl@ntNet recognises them (score ≥ 0.3), so only verified
 * PRO members see where they are. The public sees a coarse grid instead.
 *
 * Based on what Info Flora and the cantons treat as sensitive: all native
 * orchids, protected and collected plants (gentians, pasque flowers, lady's
 * slipper, edelweiss …), rare ferns and clubmosses. Fungi cannot be recognised
 * by Pl@ntNet; uploaders protect mushroom spots themselves.
 * Extend with SENSITIVE_SPECIES (comma-separated genera or binomials).
 */

const GENERA = [
  // Orchidaceae (all native orchids are protected in Switzerland)
  'Anacamptis', 'Cephalanthera', 'Chamorchis', 'Coeloglossum', 'Corallorhiza', 'Cypripedium', 'Dactylorhiza',
  'Epipactis', 'Epipogium', 'Goodyera', 'Gymnadenia', 'Hammarbya', 'Herminium', 'Himantoglossum', 'Limodorum',
  'Liparis', 'Listera', 'Malaxis', 'Neotinea', 'Neottia', 'Nigritella', 'Ophrys', 'Orchis', 'Platanthera',
  'Pseudorchis', 'Serapias', 'Spiranthes', 'Traunsteinera',
  // Other protected or collected genera
  'Pulsatilla', 'Gentiana', 'Leontopodium', 'Lycopodium', 'Huperzia', 'Diphasiastrum', 'Botrychium',
  'Ophioglossum', 'Osmunda', 'Drosera', 'Pinguicula', 'Trollius', 'Daphne', 'Cyclamen', 'Fritillaria', 'Tulipa',
];
const SPECIES = [
  'Lilium martagon', 'Lilium bulbiferum', 'Aquilegia alpina', 'Aquilegia atrata', 'Aquilegia vulgaris',
  'Primula auricula', 'Erythronium dens-canis', 'Dictamnus albus', 'Taxus baccata', 'Ilex aquifolium',
  'Leucojum vernum', 'Galanthus nivalis', 'Narcissus poeticus', 'Paeonia officinalis', 'Arnica montana',
  'Adonis vernalis', 'Iris sibirica', 'Gladiolus palustris', 'Polystichum braunii', 'Dryopteris cristata',
];

function build(extra = process.env.SENSITIVE_SPECIES || '') {
  const genera = new Set(GENERA.map((g) => g.toLowerCase()));
  const species = new Set(SPECIES.map((s) => s.toLowerCase()));
  for (const item of extra.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean)) {
    (item.includes(' ') ? species : genera).add(item);
  }
  return { genera, species };
}
let lists = build();

/** True when a scientific name (with or without author) belongs to a sensitive genus or species. */
function isSensitive(scientificName) {
  const words = String(scientificName || '').trim().toLowerCase().split(/\s+/);
  if (!words[0]) return false;
  return lists.genera.has(words[0]) || lists.species.has(`${words[0]} ${words[1] || ''}`.trim());
}

module.exports = { isSensitive, reload: (extra) => { lists = build(extra); } };
