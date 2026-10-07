'use strict';

/*
 * Regional phenological reference series for the start of autumn colouring.
 *
 * Source: DWD open data, phenology of wild plants reported by the annual
 * reporters ("Jahresmelder"),
 *   https://opendata.dwd.de/climate_environment/CDC/observations_germany/phenology/
 *   annual_reporters/wild/{historical,recent}/PH_Jahresmelder_Wildwachsende_Pflanze_<Art>_….txt
 * Semicolon-separated text, one row per station, year and phase:
 *   Stations_id;Referenzjahr;Qualitaetsniveau;Objekt_id;Phase_id;Eintrittsdatum;Eintrittsdatum_QB;Jultag;eor;
 * plus the description files in help/ for stations (name, latitude,
 * longitude, station height), plants (Objekt_id → German and Latin name) and
 * phases (Phase_id → "Blattverfärbung" …). Columns are found by their
 * header names, values are trimmed. Files are Latin-1 or UTF-8.
 *
 * Other sources (e.g. MeteoSchweiz phenology open data) can be loaded in a
 * plain generic CSV: source;station_id;station_name;lat;lon;elevation;species;year;doy
 * with the Latin species name and the day of year of the first colouring.
 *
 * The series are stored in the database. For a spot the nearest stations
 * (distance, with 100 m of altitude counting like 10 km) give the mean
 * colouring date of the last ten complete years, shifted to the spot's
 * altitude by the same 2.5 days per 100 m used elsewhere.
 */

const { treeInfo } = require('./trees');
const { DAYS_PER_100M } = require('./phenology');
const { distanceM } = require('./geo');

const DWD_BASE = 'https://opendata.dwd.de/climate_environment/CDC/observations_germany/phenology/';
const DWD_DIRS = ['annual_reporters/wild/historical/', 'annual_reporters/wild/recent/'];
const DWD_HELP = {
  stations: 'help/PH_Beschreibung_Phaenologie_Stationen_Jahresmelder.txt',
  plants: 'help/PH_Beschreibung_Pflanze.txt',
  phases: 'help/PH_Beschreibung_Phase.txt',
};
const DWD_COLOUR_PHASE = 31; // "Blattverfärbung" when no phase description is loaded

// German names as used in the DWD file names and plant descriptions.
const DWD_SPECIES = {
  rotbuche: 'Fagus sylvatica',
  stieleiche: 'Quercus robur',
  traubeneiche: 'Quercus petraea',
  haengebirke: 'Betula pendula',
  birke: 'Betula pendula',
  rosskastanie: 'Aesculus hippocastanum',
  eberesche: 'Sorbus aucuparia',
  vogelbeere: 'Sorbus aucuparia',
  sommerlinde: 'Tilia platyphyllos',
  winterlinde: 'Tilia cordata',
  spitzahorn: 'Acer platanoides',
  bergahorn: 'Acer pseudoplatanus',
  esche: 'Fraxinus excelsior',
  hainbuche: 'Carpinus betulus',
  europaeischelaerche: 'Larix decidua',
  laerche: 'Larix decidua',
  zitterpappel: 'Populus tremula',
  schwarzerle: 'Alnus glutinosa',
  salweide: 'Salix caprea',
  vogelkirsche: 'Prunus avium',
};

const MAX_DISTANCE_KM = 60; // effective distance
const KM_PER_100M = 10; // 100 m altitude difference weighs like 10 km
const MAX_STATIONS = 3;
const MIN_YEARS = 5;
const PERIOD_YEARS = 10;
const MAX_ALTITUDE_ADJUST = 25; // days

/** "Hänge-Birke" → "haengebirke" */
const norm = (s) => String(s || '').toLowerCase()
  .replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/ß/g, 'ss')
  .replace(/[^a-z]/g, '');

/** Decodes a downloaded file: UTF-8 if valid, otherwise Latin-1 (DWD's traditional encoding). */
function decodeText(buf) {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buf);
  } catch {
    return new TextDecoder('latin1').decode(buf);
  }
}

/** Semicolon table with a header row → array of objects keyed by normalised header names. */
function parseTable(text) {
  const lines = String(text).replace(/^﻿/, '').split(/\r?\n/).filter((l) => l.trim());
  if (!lines.length) return [];
  const sep = lines[0].includes(';') ? ';' : ',';
  const header = lines[0].split(sep).map(norm);
  return lines.slice(1).map((line) => {
    const cells = line.split(sep).map((c) => c.trim().replace(/^"(.*)"$/, '$1'));
    const row = {};
    header.forEach((h, i) => { if (h) row[h] = cells[i] ?? ''; });
    return row;
  });
}

const num = (v) => {
  const n = Number(String(v ?? '').trim().replace(',', '.'));
  return String(v ?? '').trim() !== '' && Number.isFinite(n) ? n : null;
};
const pick = (row, ...keys) => {
  for (const k of keys) if (row[k] !== undefined && row[k] !== '') return row[k];
  return undefined;
};

/** DWD station description → [{ id, name, lat, lon, elevation }]. */
function parseDwdStations(text) {
  return parseTable(text).map((r) => ({
    id: String(num(pick(r, 'stationsid', 'stationid')) ?? ''),
    name: pick(r, 'stationsname', 'stationname') || null,
    lat: num(pick(r, 'geographbreite', 'breite', 'lat')),
    lon: num(pick(r, 'geographlaenge', 'laenge', 'lon')),
    elevation: num(pick(r, 'stationshoehe', 'hoehe', 'elevation')),
  })).filter((s) => s.id && Number.isFinite(s.lat) && Number.isFinite(s.lon));
}

/** DWD plant description → Map(Objekt_id → Latin species of trees.js). */
function parseDwdPlants(text) {
  const map = new Map();
  for (const r of parseTable(text)) {
    const id = num(pick(r, 'objektid'));
    if (id === null) continue;
    const latin = treeInfo(pick(r, 'objektlatein') || '');
    const sci = latin?.sci || DWD_SPECIES[norm(pick(r, 'objekt'))] || null;
    if (sci) map.set(id, sci);
  }
  return map;
}

/** DWD phase description → Set of Phase_ids that mark the start of autumn colouring. */
function parseDwdPhases(text) {
  const ids = new Set();
  for (const r of parseTable(text)) {
    const id = num(pick(r, 'phaseid'));
    const name = norm(pick(r, 'phase'));
    if (id !== null && (name.includes('blattverfaerbung') || name.includes('nadelverfaerbung'))) ids.add(id);
  }
  return ids;
}

/** Species from a DWD file name like "PH_Jahresmelder_Wildwachsende_Pflanze_Rotbuche_akt.txt". */
function speciesFromFileName(name) {
  const m = /Pflanze_(.+?)(?:_\d{4}_\d{4}_hist|_akt)?\.txt$/i.exec(String(name || ''));
  return m ? DWD_SPECIES[norm(m[1])] || null : null;
}

/**
 * DWD annual-reporter observations → [{ station, species, year, doy }] for
 * the colouring phase. `species` (Latin) applies to files of a single plant;
 * otherwise Objekt_id is resolved through `plants`.
 */
function parseDwdObservations(text, { species = null, plants = null, phases = null } = {}) {
  const colourPhases = phases?.size ? phases : new Set([DWD_COLOUR_PHASE]);
  const out = [];
  for (const r of parseTable(text)) {
    const phase = num(pick(r, 'phaseid'));
    if (!colourPhases.has(phase)) continue;
    const sci = species || plants?.get(num(pick(r, 'objektid'))) || null;
    if (!sci) continue;
    const year = num(pick(r, 'referenzjahr'));
    let doy = num(pick(r, 'jultag'));
    const date = pick(r, 'eintrittsdatum');
    if (doy === null && /^\d{8}$/.test(date || '')) {
      const t = Date.UTC(+date.slice(0, 4), +date.slice(4, 6) - 1, +date.slice(6, 8));
      doy = Math.round((t - Date.UTC(+date.slice(0, 4), 0, 1)) / 86400000) + 1;
    }
    const station = String(num(pick(r, 'stationsid', 'stationid')) ?? '');
    // Plausible range for the first autumn colouring: mid-July to early December.
    if (!station || year === null || doy === null || doy < 195 || doy > 340) continue;
    out.push({ station, species: sci, year, doy });
  }
  return out;
}

/** Generic CSV (any source, e.g. converted MeteoSchweiz data). */
function parseGeneric(text) {
  const stations = new Map();
  const obs = [];
  for (const r of parseTable(text)) {
    const source = (r.source || 'generic').trim();
    const id = r.stationid;
    const sci = treeInfo(r.species || '')?.sci;
    const year = num(r.year);
    const doy = num(r.doy);
    if (!id) continue;
    if (!stations.has(`${source}|${id}`)) {
      stations.set(`${source}|${id}`, { source, id, name: r.stationname || id, lat: num(r.lat), lon: num(r.lon), elevation: num(r.elevation) });
    }
    if (sci && year !== null && doy !== null) obs.push({ source, station: id, species: sci, year, doy });
  }
  return { stations: [...stations.values()].filter((s) => Number.isFinite(s.lat) && Number.isFinite(s.lon)), observations: obs };
}

const SOURCE_LABEL = { dwd: 'DWD', meteoschweiz: 'MeteoSchweiz' };

function createPhenoRef({ db, fetchImpl = fetch, now = () => Date.now() }) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS pheno_stations (
      source TEXT NOT NULL, id TEXT NOT NULL, name TEXT, lat REAL NOT NULL, lon REAL NOT NULL, elevation REAL,
      PRIMARY KEY (source, id));
    CREATE TABLE IF NOT EXISTS pheno_obs (
      source TEXT NOT NULL, station_id TEXT NOT NULL, species TEXT NOT NULL, year INTEGER NOT NULL, doy INTEGER NOT NULL,
      PRIMARY KEY (source, station_id, species, year));
    CREATE INDEX IF NOT EXISTS pheno_obs_species ON pheno_obs (species, year);
    CREATE TABLE IF NOT EXISTS pheno_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  `);
  const insStation = db.prepare('INSERT OR REPLACE INTO pheno_stations (source, id, name, lat, lon, elevation) VALUES (?, ?, ?, ?, ?, ?)');
  const insObs = db.prepare('INSERT OR REPLACE INTO pheno_obs (source, station_id, species, year, doy) VALUES (?, ?, ?, ?, ?)');
  const setMeta = db.prepare('INSERT OR REPLACE INTO pheno_meta (key, value) VALUES (?, ?)');
  let version = 0; // bumps on import so cached selections are recomputed
  const memo = new Map();

  function store(source, stations, observations) {
    db.exec('BEGIN');
    try {
      for (const s of stations) insStation.run(s.source || source, s.id, s.name, s.lat, s.lon, s.elevation);
      for (const o of observations) insObs.run(o.source || source, o.station, o.species, o.year, o.doy);
      setMeta.run(`imported:${source}`, new Date(now()).toISOString());
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
    version++;
    memo.clear();
    return { stations: stations.length, observations: observations.length };
  }

  /**
   * Imports DWD files given as text: `stations` (station description),
   * optional `plants` and `phases` descriptions, and `files`: [{ name, text }]
   * of annual-reporter observations.
   */
  function importDwd({ stations = '', plants = '', phases = '', files = [] }) {
    const plantMap = plants ? parseDwdPlants(plants) : null;
    const phaseSet = phases ? parseDwdPhases(phases) : null;
    const obs = files.flatMap((f) => parseDwdObservations(f.text, {
      species: speciesFromFileName(f.name), plants: plantMap, phases: phaseSet,
    }));
    return store('dwd', stations ? parseDwdStations(stations) : [], obs);
  }

  const importGeneric = (text) => {
    const { stations, observations } = parseGeneric(text);
    return store(stations[0]?.source || observations[0]?.source || 'generic', stations, observations);
  };

  /** Downloads the DWD files for the species in trees.js (needs internet access to opendata.dwd.de). */
  async function syncDwd() {
    const get = async (url) => {
      const res = await fetchImpl(url, { signal: AbortSignal.timeout(60000) });
      if (!res.ok) throw new Error(`DWD antwortete mit HTTP ${res.status} für ${url}`);
      return decodeText(new Uint8Array(await res.arrayBuffer()));
    };
    const [stations, plants, phases] = await Promise.all([
      get(DWD_BASE + DWD_HELP.stations),
      get(DWD_BASE + DWD_HELP.plants).catch(() => ''),
      get(DWD_BASE + DWD_HELP.phases).catch(() => ''),
    ]);
    const files = [];
    for (const dir of DWD_DIRS) {
      const listing = await get(DWD_BASE + dir);
      const names = [...new Set([...listing.matchAll(/href="(PH_Jahresmelder_Wildwachsende_Pflanze_[^"]+\.txt)"/g)].map((m) => m[1]))]
        .filter((n) => speciesFromFileName(n));
      for (const name of names) files.push({ name, text: await get(DWD_BASE + dir + name) });
    }
    if (!files.length) throw new Error('Keine passenden DWD-Phänologiedateien gefunden');
    return { ...importDwd({ stations, plants, phases, files }), files: files.map((f) => f.name) };
  }

  const stationsOf = db.prepare(`
    SELECT s.source, s.id, s.name, s.lat, s.lon, s.elevation,
           COUNT(*) AS years, GROUP_CONCAT(o.doy) AS doys, MIN(o.year) AS first, MAX(o.year) AS last
    FROM pheno_obs o JOIN pheno_stations s ON s.source = o.source AND s.id = o.station_id
    WHERE o.species = ? AND o.year BETWEEN ? AND ?
      AND s.lat BETWEEN ? AND ? AND s.lon BETWEEN ? AND ?
    GROUP BY s.source, s.id`);

  /**
   * Reference start of colouring for `species` at a place: day of year at
   * the given altitude (null elevation: no altitude shift), with the
   * stations used. Null when no station with enough years is near.
   */
  function reference(species, { lat, lon, elevation = null }) {
    const key = `${version}|${species}|${lat.toFixed(3)}|${lon.toFixed(3)}|${elevation}`;
    if (memo.has(key)) return memo.get(key);
    const to = new Date(now()).getUTCFullYear() - 1;
    const from = to - PERIOD_YEARS + 1;
    const dLat = MAX_DISTANCE_KM / 111;
    const dLon = MAX_DISTANCE_KM / (111 * Math.cos((lat * Math.PI) / 180));
    const candidates = stationsOf.all(species, from, to, lat - dLat, lat + dLat, lon - dLon, lon + dLon)
      .filter((s) => s.years >= MIN_YEARS)
      .map((s) => {
        const doys = s.doys.split(',').map(Number).sort((a, b) => a - b);
        const median = doys[Math.floor(doys.length / 2)];
        const kept = doys.filter((d) => Math.abs(d - median) <= 21); // drop obvious misreports
        const mean = kept.reduce((a, b) => a + b, 0) / kept.length;
        const km = distanceM({ lat, lon }, { lat: s.lat, lon: s.lon }) / 1000;
        const dh = Number.isFinite(elevation) && Number.isFinite(s.elevation) ? elevation - s.elevation : 0;
        const eff = Math.hypot(km, (dh / 100) * KM_PER_100M);
        const adjust = Math.max(-MAX_ALTITUDE_ADJUST, Math.min(MAX_ALTITUDE_ADJUST, -(dh / 100) * DAYS_PER_100M));
        return { ...s, mean, km, eff, adjust, years: kept.length };
      })
      .filter((s) => s.eff <= MAX_DISTANCE_KM)
      .sort((a, b) => a.eff - b.eff)
      .slice(0, MAX_STATIONS);
    let result = null;
    if (candidates.length) {
      const w = candidates.map((s) => 1 / Math.max(1, s.eff) ** 2);
      const sw = w.reduce((a, b) => a + b, 0);
      const doy = Math.round(candidates.reduce((a, s, i) => a + w[i] * (s.mean + s.adjust), 0) / sw);
      const first = Math.min(...candidates.map((s) => s.first));
      const last = Math.max(...candidates.map((s) => s.last));
      const main = candidates[0];
      const src = SOURCE_LABEL[main.source] || main.source;
      result = {
        species,
        doy,
        period: [first, last],
        stations: candidates.map((s) => ({
          source: s.source, id: s.id, name: s.name,
          distanceKm: Math.round(s.km), elevation: Number.isFinite(s.elevation) ? Math.round(s.elevation) : null,
          years: s.years, meanDoy: Math.round(s.mean), altitudeAdjust: Math.round(s.adjust),
        })),
        label: `Referenz: ${src}-Station ${main.name}, ${Math.round(main.km)} km` +
          (Number.isFinite(main.elevation) ? `, ${Math.round(main.elevation)} m` : '') +
          `, Mittel ${first}–${last}` +
          (candidates.length > 1 ? ` (+${candidates.length - 1} weitere)` : ''),
      };
    }
    memo.set(key, result);
    if (memo.size > 500) memo.delete(memo.keys().next().value);
    return result;
  }

  /** References for several species at a place: { sci: reference }. */
  function forPlace(speciesList, place) {
    const out = {};
    for (const sci of speciesList) {
      const r = reference(sci, place);
      if (r) out[sci] = r;
    }
    return out;
  }

  const status = () => ({
    stations: db.prepare('SELECT COUNT(*) AS n FROM pheno_stations').get().n,
    observations: db.prepare('SELECT COUNT(*) AS n FROM pheno_obs').get().n,
    species: db.prepare('SELECT species, COUNT(*) AS n, MIN(year) AS first, MAX(year) AS last FROM pheno_obs GROUP BY species ORDER BY species').all(),
    imported: Object.fromEntries(db.prepare("SELECT key, value FROM pheno_meta WHERE key LIKE 'imported:%'").all()
      .map((r) => [r.key.slice(9), r.value])),
  });

  return { importDwd, importGeneric, syncDwd, reference, forPlace, status };
}

module.exports = {
  createPhenoRef, parseTable, parseDwdStations, parseDwdPlants, parseDwdPhases, parseDwdObservations, parseGeneric,
  speciesFromFileName, decodeText, DWD_BASE,
};
