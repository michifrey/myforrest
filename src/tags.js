'use strict';

/** Fixed vocabulary for observations, so spots can be filtered and compared. */
const TAGS = {
  sturmschaden: 'Sturmschaden / Windwurf',
  borkenkaefer: 'Borkenkäfer',
  trockenschaden: 'Trockenschaden',
  totholz: 'Totholz',
  holzschlag: 'Holzschlag / Rodung',
  verjuengung: 'Verjüngung / Aufforstung',
  fruehverfaerbung: 'Frühe Laubverfärbung',
  neophyt: 'Neophyt',
  wegschaden: 'Weg / Erosion',
};

const isTag = (t) => Object.prototype.hasOwnProperty.call(TAGS, t);

/** Accepts an array or comma separated string; returns known, unique tags. */
function parseTags(input) {
  const list = Array.isArray(input) ? input : String(input || '').split(',');
  return [...new Set(list.map((t) => String(t).trim().toLowerCase()).filter(isTag))];
}

module.exports = { TAGS, isTag, parseTags };
