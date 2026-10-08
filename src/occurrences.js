'use strict';

/**
 * Species occurrences ("Funde") derived from the Pl@ntNet identifications.
 *
 * Pl@ntNet returns up to five candidate species per photo; they are
 * alternatives for the same plant, not five plants. An occurrence is therefore
 * the best-scoring candidate of a photo (one occurrence per photo), located at
 * the photo's own position and time. Filters narrow the list down for maps
 * and exports.
 */

const { neophyteName } = require('./neophytes');

const DEFAULT_MIN_SCORE = 0.2;

/**
 * Rough position accuracy (m) per way the photo was located, for Darwin Core.
 * Repeat photos placed at their spot ('spot') get the spot radius.
 */
const UNCERTAINTY_M = { exif: 15, gpx: 25, manual: 50 };

const normalizeName = (name) => String(name || '').toLowerCase().replace(/\s+/g, ' ').trim();
const binomial = (name) => normalizeName(name).split(' ').slice(0, 2).join(' ');

const { LICENSES } = require('./moderation');

const columnsOf = (db) => new Set(db.prepare('PRAGMA table_info(photos)').all().map((c) => c.name));

/** Licence for export: the Creative Commons URI (as Darwin Core recommends), or the label without one. */
function licenseForExport(key) {
  const lic = key && LICENSES[key];
  if (!lic) return key || null;
  return lic.url ? lic.url.replace(/deed\.de$/, '') : lic.label;
}

/**
 * Parses filter query parameters. Unknown or malformed values throw an Error
 * with `status = 400` so routes can answer with a clear message.
 */
function parseFilters(q = {}) {
  const bad = (msg) => Object.assign(new Error(msg), { status: 400 });
  const f = { species: null, neophytes: false, minScore: DEFAULT_MIN_SCORE, bbox: null, from: null, to: null };
  if (q.species) f.species = String(q.species).slice(0, 200);
  if (q.neophytes !== undefined) f.neophytes = ['1', 'true', 'ja', 'yes'].includes(String(q.neophytes).toLowerCase());
  if (q.minScore !== undefined && q.minScore !== '') {
    const s = Number(q.minScore);
    if (!Number.isFinite(s) || s < 0 || s > 1) throw bad('minScore muss zwischen 0 und 1 liegen');
    f.minScore = s;
  }
  if (q.bbox) {
    const b = String(q.bbox).split(',').map(Number);
    if (b.length !== 4 || b.some((v) => !Number.isFinite(v))) throw bad('bbox muss "west,süd,ost,nord" sein');
    const [west, south, east, north] = b;
    if (south > north || south < -90 || north > 90) throw bad('bbox ist ungültig');
    f.bbox = { west, south, east, north };
  }
  for (const key of ['from', 'to']) {
    if (!q[key]) continue;
    const s = String(q[key]);
    // A bare date for "to" includes the whole day.
    const t = /^\d{4}-\d{2}-\d{2}$/.test(s) ? Date.parse(`${s}T00:00:00Z`) + (key === 'to' ? 86400000 - 1 : 0) : Date.parse(s);
    if (!Number.isFinite(t)) throw bad(`${key} ist kein gültiges Datum`);
    f[key] = t;
  }
  return f;
}

/**
 * Occurrences matching the filters, oldest first. Each has the photo's
 * position and time, the best Pl@ntNet candidate and – if present – the photo
 * licence.
 */
function listOccurrences(db, filters = {}) {
  const f = { minScore: DEFAULT_MIN_SCORE, ...filters };
  const cols = columnsOf(db);
  const license = cols.has('license') ? 'p.license' : 'NULL';
  const where = ['i.score >= ?'];
  // Photos hidden by moderators are never exported or mapped; protected finds only for those who may see them.
  if (f.visibleSql) where.push(`(${f.visibleSql})`);
  else {
    if (cols.has('hidden_at')) where.push('p.hidden_at IS NULL');
    if (cols.has('protected')) where.push('COALESCE(p.protected, 0) = 0');
  }
  const args = [f.minScore];
  if (f.from !== null && f.from !== undefined) { where.push('p.taken_at >= ?'); args.push(f.from); }
  if (f.to !== null && f.to !== undefined) { where.push('p.taken_at <= ?'); args.push(f.to); }
  if (f.bbox) {
    where.push('p.lat BETWEEN ? AND ?');
    args.push(f.bbox.south, f.bbox.north);
    if (f.bbox.west <= f.bbox.east) {
      where.push('p.lon BETWEEN ? AND ?');
      args.push(f.bbox.west, f.bbox.east);
    } else { // box across the antimeridian
      where.push('(p.lon >= ? OR p.lon <= ?)');
      args.push(f.bbox.west, f.bbox.east);
    }
  }
  // Best candidate per photo: no other identification of the photo scores higher
  // (ties broken by the lower id, i.e. Pl@ntNet's own order).
  const rows = db.prepare(`
    SELECT p.id AS photo_id, p.spot_id, p.file, p.taken_at, p.lat, p.lon, p.location_source, p.note,
           ${license} AS license,
           i.scientific_name, i.common_name, i.score, i.neophyte
    FROM identifications i
    JOIN photos p ON p.id = i.photo_id
    WHERE ${where.join(' AND ')}
      AND NOT EXISTS (
        SELECT 1 FROM identifications j
        WHERE j.photo_id = i.photo_id AND (j.score > i.score OR (j.score = i.score AND j.id < i.id))
      )
    ORDER BY p.taken_at, p.id
  `).all(...args);

  const wanted = f.species ? binomial(f.species) : null;
  return rows
    .map((r) => ({
      photoId: r.photo_id,
      spotId: r.spot_id,
      file: r.file,
      takenAt: r.taken_at,
      lat: r.lat,
      lon: r.lon,
      locationSource: r.location_source,
      uncertaintyM: r.location_source === 'spot' ? (f.spotRadiusM ?? 25) : (UNCERTAINTY_M[r.location_source] ?? null),
      note: r.note,
      license: licenseForExport(r.license),
      scientificName: r.scientific_name,
      commonName: r.common_name,
      score: r.score,
      // Stored flag, or the current list (the list may have grown since identification).
      neophyte: r.neophyte || neophyteName(r.scientific_name),
    }))
    .filter((o) => (!f.neophytes || o.neophyte) && (!wanted || binomial(o.scientificName) === wanted));
}

/** Species with at least one occurrence: counts, years and neophyte status. */
function speciesSummary(db, filters = {}) {
  const by = new Map();
  for (const o of listOccurrences(db, filters)) {
    const key = binomial(o.scientificName);
    let s = by.get(key);
    if (!s) {
      s = { scientificName: o.scientificName, commonName: o.commonName, neophyte: o.neophyte, count: 0, spots: new Set(), years: new Set(), first: o.takenAt, last: o.takenAt };
      by.set(key, s);
    }
    s.count++;
    s.spots.add(o.spotId);
    s.years.add(new Date(o.takenAt).getUTCFullYear());
    s.commonName = s.commonName || o.commonName;
    s.neophyte = s.neophyte || o.neophyte;
    s.last = o.takenAt;
  }
  return [...by.values()]
    .map((s) => ({
      scientificName: s.scientificName,
      commonName: s.commonName,
      neophyte: s.neophyte || null,
      count: s.count,
      spots: s.spots.size,
      years: [...s.years].sort((a, b) => a - b),
      first: new Date(s.first).toISOString(),
      last: new Date(s.last).toISOString(),
    }))
    .sort((a, b) => Boolean(b.neophyte) - Boolean(a.neophyte) || b.count - a.count || a.scientificName.localeCompare(b.scientificName));
}

module.exports = { listOccurrences, speciesSummary, parseFilters, licenseForExport, binomial, DEFAULT_MIN_SCORE, UNCERTAINTY_M };
