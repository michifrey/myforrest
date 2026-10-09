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

/* ---------- Lists per canton (Rote Liste, cantonal protection ordinances) ---------- */

const CANTONS = ['AG', 'AI', 'AR', 'BE', 'BL', 'BS', 'FR', 'GE', 'GL', 'GR', 'JU', 'LU', 'NE', 'NW', 'OW', 'SG', 'SH', 'SO', 'SZ',
  'TG', 'TI', 'UR', 'VD', 'VS', 'ZG', 'ZH'];
const normName = (n) => String(n || '').trim().toLowerCase().split(/\s+/).slice(0, 2).join(' ');

/**
 * Protection lists loaded into the database: per canton (two-letter code) or
 * for all of Switzerland ('CH'), genera or species. A name is sensitive at a
 * spot when the built-in list, the 'CH' list or the spot's canton lists it;
 * when the canton is not known (outside Switzerland, lookup failed), any
 * canton's list counts, to be on the safe side.
 */
function createSensitiveLists(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS protected_species (
    canton    TEXT NOT NULL,
    name      TEXT NOT NULL,
    status    TEXT,
    source    TEXT,
    loaded_at INTEGER NOT NULL,
    PRIMARY KEY (canton, name)
  )`);
  const lookup = db.prepare('SELECT canton, status, source FROM protected_species WHERE name = ? OR name = ?');

  /** Why a name is protected in a canton: { list: 'eingebaut' | 'CH' | canton code, status, source } or null. */
  function why(scientificName, canton = null) {
    if (isSensitive(scientificName)) return { list: 'eingebaut', status: 'geschützt', source: 'MyForrest' };
    const n = normName(scientificName);
    if (!n) return null;
    const rows = lookup.all(n, n.split(' ')[0]);
    // canton: code; '' outside Switzerland (cantonal lists do not apply); null unknown (any canton counts).
    const hit = rows.find((r) => r.canton === 'CH') || (canton === '' ? null : rows.find((r) => (canton ? r.canton === canton : true)));
    return hit ? { list: hit.canton, status: hit.status, source: hit.source } : null;
  }

  /**
   * Imports a list as CSV (`kanton;art;status;quelle`, header line, `;` or `,`).
   * `replace` drops the earlier entries of the cantons in the file first.
   * Returns { imported, cantons, skipped: [{ line, reason }] }.
   */
  function importCsv(text, { replace = true, now = Date.now() } = {}) {
    const lines = String(text).replace(/^\uFEFF/, '').split(/\r?\n/).filter((l) => l.trim());
    if (!lines.length) return { imported: 0, cantons: [], skipped: [] };
    const sep = lines[0].includes(';') ? ';' : ',';
    const head = lines[0].split(sep).map((h) => h.trim().toLowerCase());
    const col = (names) => head.findIndex((h) => names.includes(h));
    const ci = col(['kanton', 'canton']);
    const ni = col(['art', 'species', 'name', 'taxon']);
    const si = col(['status', 'schutzstatus']);
    const qi = col(['quelle', 'source']);
    if (ci < 0 || ni < 0) throw new Error('Spalten «kanton» und «art» fehlen');
    const rows = [];
    const skipped = [];
    lines.slice(1).forEach((line, k) => {
      const f = line.split(sep).map((v) => v.trim().replace(/^"(.*)"$/, '$1'));
      const canton = (f[ci] || '').toUpperCase();
      const name = normName(f[ni]);
      if (canton !== 'CH' && !CANTONS.includes(canton)) skipped.push({ line: k + 2, reason: `Unbekannter Kanton «${f[ci] || ''}»` });
      else if (!/^[a-z×-]+( [a-z×-]+)?$/.test(name)) skipped.push({ line: k + 2, reason: `Kein lateinischer Name «${f[ni] || ''}»` });
      else rows.push({ canton, name, status: f[si] || null, source: f[qi] || null });
    });
    const cantons = [...new Set(rows.map((r) => r.canton))].sort();
    db.exec('BEGIN');
    try {
      if (replace) for (const c of cantons) db.prepare('DELETE FROM protected_species WHERE canton = ?').run(c);
      const ins = db.prepare('INSERT OR REPLACE INTO protected_species (canton, name, status, source, loaded_at) VALUES (?, ?, ?, ?, ?)');
      for (const r of rows) ins.run(r.canton, r.name, r.status, r.source, now);
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
    return { imported: rows.length, cantons, skipped };
  }

  /** Loaded lists per canton: [{ canton, entries, sources, loadedAt }]. */
  const status = () => db.prepare(`SELECT canton, COUNT(*) AS entries, GROUP_CONCAT(DISTINCT source) AS sources, MAX(loaded_at) AS loaded
    FROM protected_species GROUP BY canton ORDER BY canton`).all()
    .map((r) => ({ canton: r.canton, entries: r.entries, sources: r.sources ? r.sources.split(',') : [], loadedAt: new Date(r.loaded).toISOString() }));

  const remove = (canton) => db.prepare('DELETE FROM protected_species WHERE canton = ?').run(String(canton).toUpperCase()).changes;

  return { why, isSensitive: (name, canton) => Boolean(why(name, canton)), importCsv, status, remove };
}

module.exports = { isSensitive, createSensitiveLists, CANTONS, reload: (extra) => { lists = build(extra); } };
