'use strict';

/**
 * File exports of species occurrences for biodiversity portals.
 *
 *  - Darwin Core occurrence CSV (https://dwc.tdwg.org/terms/): the common
 *    exchange format of GBIF, Info Flora and most national data centres.
 *  - iNaturalist CSV import (https://www.inaturalist.org/observations/import):
 *    the columns of iNaturalist's bulk-import template. iNaturalist's CSV
 *    import does not take photos, so the photo link goes into the description.
 *
 * Uploading directly to iNaturalist or Info Flora would need an account and
 * OAuth on their side; only files are produced here.
 */

const DWC_COLUMNS = [
  'occurrenceID', 'basisOfRecord', 'scientificName', 'vernacularName', 'kingdom', 'taxonRank',
  'eventDate', 'year', 'month', 'day',
  'decimalLatitude', 'decimalLongitude', 'geodeticDatum', 'coordinateUncertaintyInMeters', 'georeferenceRemarks',
  'establishmentMeans', 'identifiedBy', 'identificationVerificationStatus', 'identificationRemarks',
  'occurrenceRemarks', 'associatedMedia', 'license',
];

const INAT_COLUMNS = [
  'Taxon name', 'Date observed', 'Description', 'Place name',
  'Latitude / y coord / northing', 'Longitude / x coord / easting', 'Tags', 'Geoprivacy',
];

const GEOREF = {
  exif: 'GPS aus den Bilddaten (EXIF)',
  gpx: 'über die Aufnahmezeit auf einem GPX-Track verortet',
  manual: 'von Hand auf der Karte gesetzt',
  spot: 'Wiederholungsfoto, Position des Spots',
};

/**
 * One CSV field (RFC 4180). Text that a spreadsheet would run as a formula
 * (leading =, +, -, @) gets a leading apostrophe; numbers stay untouched.
 */
function csvField(value) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : '';
  let s = String(value);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

const csvLine = (values) => values.map(csvField).join(',');
const toCsv = (columns, rows) => `${[csvLine(columns), ...rows.map((r) => csvLine(columns.map((c) => r[c])))].join('\r\n')}\r\n`;

const scoreText = (score) => `Automatisch bestimmt mit Pl@ntNet, Score ${score.toFixed(2)}`;
const mediaUrl = (base, o) => `${base}/uploads/${encodeURIComponent(o.file)}`;

/** Darwin Core occurrence CSV for the given occurrences. `base` is the absolute site URL. */
function darwinCoreCsv(occurrences, { base }) {
  const rows = occurrences.map((o) => {
    const d = new Date(o.takenAt);
    return {
      occurrenceID: `${base}/#photo-${o.photoId}`,
      basisOfRecord: 'HumanObservation',
      scientificName: o.scientificName,
      vernacularName: o.neophyte || o.commonName || '',
      kingdom: 'Plantae',
      taxonRank: o.scientificName.trim().split(/\s+/).length >= 2 ? 'species' : '',
      eventDate: d.toISOString().replace('.000Z', 'Z'),
      year: d.getUTCFullYear(),
      month: d.getUTCMonth() + 1,
      day: d.getUTCDate(),
      decimalLatitude: Math.round(o.lat * 1e6) / 1e6,
      decimalLongitude: Math.round(o.lon * 1e6) / 1e6,
      geodeticDatum: 'WGS84',
      coordinateUncertaintyInMeters: o.uncertaintyM,
      georeferenceRemarks: GEOREF[o.locationSource] || '',
      establishmentMeans: o.neophyte ? 'introduced' : '',
      identifiedBy: o.verification ? 'Pl@ntNet (automatisch), von Hand geprüft (MyForrest)' : 'Pl@ntNet (automatisch)',
      identificationVerificationStatus: o.verification ? 'verified' : 'unverified',
      identificationRemarks: reviewText(o),
      occurrenceRemarks: o.note || '',
      associatedMedia: mediaUrl(base, o),
      license: o.license || '',
    };
  });
  return toCsv(DWC_COLUMNS, rows);
}

/** Score text, plus the human review: confirmed, or corrected from Pl@ntNet's proposal. */
function reviewText(o) {
  const day = o.reviewedAt ? ` am ${new Date(o.reviewedAt).toISOString().slice(0, 10)}` : '';
  if (o.verification === 'korrigiert') return `Von Hand korrigiert${day} (Pl@ntNet schlug ${o.plantnetName} vor)`;
  if (o.verification === 'bestaetigt') return `${scoreText(o.score)}, von Hand bestätigt${day}`;
  return scoreText(o.score);
}

/** iNaturalist bulk-import CSV for the given occurrences. */
function inaturalistCsv(occurrences, { base }) {
  const rows = occurrences.map((o) => {
    const parts = [reviewText(o)];
    if (o.neophyte) parts.push(`Invasiver Neophyt: ${o.neophyte}`);
    if (o.note) parts.push(o.note);
    parts.push(`Foto: ${mediaUrl(base, o)}`);
    if (o.license) parts.push(`Lizenz: ${o.license}`);
    const tags = ['myforrest', 'plantnet'];
    if (o.neophyte) tags.push('neophyt');
    return {
      'Taxon name': o.scientificName,
      'Date observed': new Date(o.takenAt).toISOString().replace('.000Z', 'Z'),
      Description: parts.join(' · '),
      'Place name': '',
      'Latitude / y coord / northing': Math.round(o.lat * 1e6) / 1e6,
      'Longitude / x coord / easting': Math.round(o.lon * 1e6) / 1e6,
      Tags: tags.join(','),
      Geoprivacy: 'open',
    };
  });
  return toCsv(INAT_COLUMNS, rows);
}

module.exports = { darwinCoreCsv, inaturalistCsv, csvField, DWC_COLUMNS, INAT_COLUMNS };
