'use strict';

/*
 * Regional phenological reference series for the start of autumn colouring
 * and for leaf-out (the start of leaf unfolding, for late frost).
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
 * The DWD immediate reporters ("Sofortmelder", immediate_reporters/wild/recent/)
 * report the current year within days; they give this year's leaf-out.
 *
 * MeteoSchweiz phenology open data (OGD, data.geo.admin.ch, collection
 * ch.meteoschweiz.ogd-phenology) is read directly: a station description
 * (station_abbr, station_name, station_coordinates_wgs84_lat/_lon,
 * station_height_masl), a parameter description (parameter_shortname,
 * parameter_description_de such as "Buche: Blattentfaltung") and the
 * observations (station_abbr, reference year, parameter, day of year or date).
 * Columns are found by name; species and phase come from the German
 * parameter description. Written after the published description of the
 * files, not yet checked against real downloads.
 *
 * Other sources can be loaded in a plain generic CSV:
 *   source;station_id;station_name;lat;lon;elevation;species;year;doy[;phase]
 * with the Latin species name, the day of year and the phase (colour, the
 * default, or leafout).
 *
 * The series are stored in the database. For a spot the nearest stations
 * (distance, with 100 m of altitude counting like 10 km) give the mean date
 * of the last ten complete years, shifted to the spot's altitude: colouring
 * 2.5 days earlier per 100 m, leaf-out 3 days later per 100 m. For leaf-out
 * the current year's observations replace the mean once a station nearby
 * has reported.
 */

const { treeInfo } = require('./trees');
const { DAYS_PER_100M } = require('./phenology');
const { distanceM } = require('./geo');

const DWD_BASE = 'https://opendata.dwd.de/climate_environment/CDC/observations_germany/phenology/';
const DWD_DIRS = ['annual_reporters/wild/historical/', 'annual_reporters/wild/recent/'];
const DWD_IMMEDIATE_DIR = 'immediate_reporters/wild/recent/';
const DWD_HELP = {
  stations: 'help/PH_Beschreibung_Phaenologie_Stationen_Jahresmelder.txt',
  immediateStations: 'help/PH_Beschreibung_Phaenologie_Stationen_Sofortmelder.txt',
  plants: 'help/PH_Beschreibung_Pflanze.txt',
  phases: 'help/PH_Beschreibung_Phase.txt',
};
const DWD_COLOUR_PHASE = 31; // "Blattverfärbung" when no phase description is loaded
const DWD_LEAFOUT_PHASE = 4; // "Blattentfaltung"
const METEOSCHWEIZ_STAC = 'https://data.geo.admin.ch/api/stac/v1/collections/ch.meteoschweiz.ogd-phenology';

// Plausible days of year per phase: colouring mid-July to early December, leaf-out March to June.
const PHASE_RANGE = { colour: [195, 340], leafout: [60, 180] };
const LEAFOUT_DAYS_PER_100M = 3; // later uphill

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
  // Short names as in the MeteoSchweiz parameter descriptions.
  buche: 'Fagus sylvatica',
  rosskastanie: 'Aesculus hippocastanum',
  europaeischelaerche: 'Larix decidua',
  stieleiche: 'Quercus robur',
};

/** Phase of a German phase name: 'colour', 'leafout' or null. */
function phaseOfName(name) {
  const n = norm(name);
  if (n.includes('blattverfaerbung') || n.includes('nadelverfaerbung')) return 'colour';
  if (n.includes('blattentfaltung') || n.includes('nadelaustrieb') || n.includes('austrieb')) return 'leafout';
  return null;
}
/** Species named in a German text ("Buche: Blattentfaltung"): the longest matching name wins (Hainbuche, not Buche). */
function speciesOfText(text) {
  const n = norm(text);
  const hit = Object.keys(DWD_SPECIES).filter((k) => n.includes(k)).sort((a, b) => b.length - a.length)[0];
  return hit ? DWD_SPECIES[hit] : null;
}
/** Day of year from "YYYYMMDD", "YYYY-MM-DD" or "DD.MM.YYYY". */
function doyOfDate(v) {
  const s = String(v || '').trim();
  const iso = /^(\d{4})-?(\d{2})-?(\d{2})/.exec(s);
  const ch = /^(\d{1,2})\.(\d{1,2})\.(\d{4})/.exec(s);
  const [y, m, d] = iso ? [+iso[1], +iso[2], +iso[3]] : ch ? [+ch[3], +ch[2], +ch[1]] : [];
  if (!y) return null;
  return Math.round((Date.UTC(y, m - 1, d) - Date.UTC(y, 0, 1)) / 86400000) + 1;
}

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
  return new Set([...parseDwdPhaseKinds(text)].filter(([, kind]) => kind === 'colour').map(([id]) => id));
}
/** DWD phase description → Map(Phase_id → 'colour' | 'leafout') for the phases used here. */
function parseDwdPhaseKinds(text) {
  const kinds = new Map();
  for (const r of parseTable(text)) {
    const id = num(pick(r, 'phaseid'));
    const kind = phaseOfName(pick(r, 'phase'));
    if (id !== null && kind) kinds.set(id, kind);
  }
  return kinds;
}

/** Species from a DWD file name like "PH_Jahresmelder_Wildwachsende_Pflanze_Rotbuche_akt.txt". */
function speciesFromFileName(name) {
  const m = /Pflanze_(.+?)(?:_\d{4}_\d{4}_hist|_akt)?\.txt$/i.exec(String(name || ''));
  return m ? DWD_SPECIES[norm(m[1])] || null : null;
}

/**
 * DWD annual- or immediate-reporter observations → [{ station, species, year, doy, phase }]
 * for colouring and leaf-out. `species` (Latin) applies to files of a single plant;
 * otherwise Objekt_id is resolved through `plants`. `phases`: Map(Phase_id → kind),
 * or a Set of colouring phases (older callers).
 */
function parseDwdObservations(text, { species = null, plants = null, phases = null } = {}) {
  const kinds = phases instanceof Map && phases.size ? phases
    : phases instanceof Set && phases.size ? new Map([...phases].map((id) => [id, 'colour']))
      : new Map([[DWD_COLOUR_PHASE, 'colour'], [DWD_LEAFOUT_PHASE, 'leafout']]);
  const out = [];
  for (const r of parseTable(text)) {
    const kind = kinds.get(num(pick(r, 'phaseid')));
    if (!kind) continue;
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
    const [lo, hi] = PHASE_RANGE[kind];
    if (!station || year === null || doy === null || doy < lo || doy > hi) continue;
    out.push({ station, species: sci, year, doy, phase: kind });
  }
  return out;
}

/**
 * MeteoSchweiz phenology open data → { stations, observations }. `stations` and `parameters`
 * are the description files, `data` one or more observation files (text).
 */
function parseMeteoSchweiz({ stations = '', parameters = '', data = [] }) {
  const st = parseTable(stations).map((r) => ({
    source: 'meteoschweiz',
    id: pick(r, 'stationabbr', 'natabbr', 'station') || '',
    name: pick(r, 'stationname', 'name') || null,
    lat: num(pick(r, 'stationcoordinateswgslat', 'lat', 'latitude')),
    lon: num(pick(r, 'stationcoordinateswgslon', 'lon', 'longitude')),
    elevation: num(pick(r, 'stationheightmasl', 'stationheight', 'elevation', 'hoehe')),
  })).filter((s) => s.id && Number.isFinite(s.lat) && Number.isFinite(s.lon));
  // Parameter → { species, phase } from the German description.
  const params = new Map();
  for (const r of parseTable(parameters)) {
    const id = pick(r, 'parametershortname', 'parameter', 'paramid');
    const text = pick(r, 'parameterdescriptionde', 'beschreibung', 'description') || '';
    const species = speciesOfText(text);
    const phase = phaseOfName(text);
    if (id && species && phase) params.set(id, { species, phase });
  }
  const obs = [];
  for (const text of [].concat(data)) {
    for (const r of parseTable(text)) {
      const p = params.get(pick(r, 'paramid', 'parametershortname', 'parameter') || '');
      const station = pick(r, 'stationabbr', 'natabbr', 'station');
      if (!p || !station) continue;
      const rawYear = pick(r, 'referenceyear', 'year', 'jahr', 'referencetimestamp') || '';
      const year = num(/\d{4}/.exec(rawYear)?.[0]);
      const value = pick(r, 'value', 'doy', 'tag', 'date', 'datum');
      let doy = num(value);
      if (doy === null || doy > 366) doy = doyOfDate(value);
      const [lo, hi] = PHASE_RANGE[p.phase];
      if (year === null || doy === null || doy < lo || doy > hi) continue;
      obs.push({ source: 'meteoschweiz', station, species: p.species, year, doy, phase: p.phase });
    }
  }
  return { stations: st, observations: obs };
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
    const phase = phaseOfName(r.phase) || (/^leaf/i.test(r.phase || '') ? 'leafout' : 'colour');
    if (!id) continue;
    if (!stations.has(`${source}|${id}`)) {
      stations.set(`${source}|${id}`, { source, id, name: r.stationname || id, lat: num(r.lat), lon: num(r.lon), elevation: num(r.elevation) });
    }
    if (sci && year !== null && doy !== null) obs.push({ source, station: id, species: sci, year, doy, phase });
  }
  return { stations: [...stations.values()].filter((s) => Number.isFinite(s.lat) && Number.isFinite(s.lon)), observations: obs };
}

const SOURCE_LABEL = { dwd: 'DWD', 'dwd-sofort': 'DWD-Sofortmelder', meteoschweiz: 'MeteoSchweiz' };

function createPhenoRef({ db, fetchImpl = fetch, now = () => Date.now() }) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS pheno_stations (
      source TEXT NOT NULL, id TEXT NOT NULL, name TEXT, lat REAL NOT NULL, lon REAL NOT NULL, elevation REAL,
      PRIMARY KEY (source, id));
    CREATE TABLE IF NOT EXISTS pheno_obs (
      source TEXT NOT NULL, station_id TEXT NOT NULL, species TEXT NOT NULL, year INTEGER NOT NULL, doy INTEGER NOT NULL,
      PRIMARY KEY (source, station_id, species, year));
    CREATE INDEX IF NOT EXISTS pheno_obs_species ON pheno_obs (species, year);
    -- Leaf-out (start of leaf unfolding), same layout; kept apart so the colouring table stays as it was.
    CREATE TABLE IF NOT EXISTS pheno_leafout (
      source TEXT NOT NULL, station_id TEXT NOT NULL, species TEXT NOT NULL, year INTEGER NOT NULL, doy INTEGER NOT NULL,
      PRIMARY KEY (source, station_id, species, year));
    CREATE INDEX IF NOT EXISTS pheno_leafout_species ON pheno_leafout (species, year);
    CREATE TABLE IF NOT EXISTS pheno_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  `);
  const insStation = db.prepare('INSERT OR REPLACE INTO pheno_stations (source, id, name, lat, lon, elevation) VALUES (?, ?, ?, ?, ?, ?)');
  const insObs = db.prepare('INSERT OR REPLACE INTO pheno_obs (source, station_id, species, year, doy) VALUES (?, ?, ?, ?, ?)');
  const insLeaf = db.prepare('INSERT OR REPLACE INTO pheno_leafout (source, station_id, species, year, doy) VALUES (?, ?, ?, ?, ?)');
  const setMeta = db.prepare('INSERT OR REPLACE INTO pheno_meta (key, value) VALUES (?, ?)');
  let version = 0; // bumps on import so cached selections are recomputed
  const memo = new Map();

  function store(source, stations, observations) {
    db.exec('BEGIN');
    try {
      for (const s of stations) insStation.run(s.source || source, s.id, s.name, s.lat, s.lon, s.elevation);
      for (const o of observations) (o.phase === 'leafout' ? insLeaf : insObs).run(o.source || source, o.station, o.species, o.year, o.doy);
      setMeta.run(`imported:${source}`, new Date(now()).toISOString());
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
    version++;
    memo.clear();
    const leafout = observations.filter((o) => o.phase === 'leafout').length;
    return { stations: stations.length, observations: observations.length - leafout, leafout };
  }

  /**
   * Imports DWD files given as text: `stations` (station description),
   * optional `plants` and `phases` descriptions, and `files`: [{ name, text }]
   * of annual-reporter observations.
   */
  function importDwd({ stations = '', plants = '', phases = '', files = [] }) {
    const plantMap = plants ? parseDwdPlants(plants) : null;
    const phaseSet = phases ? parseDwdPhaseKinds(phases) : null;
    const obs = files.flatMap((f) => parseDwdObservations(f.text, {
      species: speciesFromFileName(f.name), plants: plantMap, phases: phaseSet,
    }));
    return store('dwd', stations ? parseDwdStations(stations) : [], obs);
  }

  /** Imports MeteoSchweiz OGD phenology files given as text (see parseMeteoSchweiz). */
  const importMeteoSchweiz = (files) => {
    const { stations, observations } = parseMeteoSchweiz(files);
    return store('meteoschweiz', stations, observations);
  };

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
    const result = { ...importDwd({ stations, plants, phases, files }), files: files.map((f) => f.name) };
    // This year's leaf-out from the immediate reporters (their own station list); optional.
    try {
      const immediateStations = await get(DWD_BASE + DWD_HELP.immediateStations);
      const listing = await get(DWD_BASE + DWD_IMMEDIATE_DIR);
      const names = [...new Set([...listing.matchAll(/href="(PH_Sofortmelder_Wildwachsende_Pflanze_[^"]+\.txt)"/g)].map((m) => m[1]))]
        .filter((n) => speciesFromFileName(n));
      const current = [];
      for (const name of names) current.push({ name, text: await get(DWD_BASE + DWD_IMMEDIATE_DIR + name) });
      // Immediate reporters have their own station numbers: kept apart as source "dwd-sofort".
      const obs = current.flatMap((f) => parseDwdObservations(f.text, { species: speciesFromFileName(f.name), plants: plants ? parseDwdPlants(plants) : null, phases: phases ? parseDwdPhaseKinds(phases) : null }))
        .map((o) => ({ ...o, source: 'dwd-sofort' }));
      result.immediate = store('dwd-sofort', parseDwdStations(immediateStations).map((x) => ({ ...x, source: 'dwd-sofort' })), obs);
    } catch (err) {
      result.immediateError = err.message;
    }
    return result;
  }

  /**
   * Downloads the MeteoSchweiz phenology open data through the STAC API of data.geo.admin.ch:
   * the description files of the collection and the observation files of its items.
   */
  async function syncMeteoSchweiz() {
    const getJson = async (url) => {
      const res = await fetchImpl(url, { signal: AbortSignal.timeout(60000) });
      if (!res.ok) throw new Error(`data.geo.admin.ch antwortete mit HTTP ${res.status} für ${url}`);
      return res.json();
    };
    const getText = async (url) => {
      const res = await fetchImpl(url, { signal: AbortSignal.timeout(120000) });
      if (!res.ok) throw new Error(`data.geo.admin.ch antwortete mit HTTP ${res.status} für ${url}`);
      return decodeText(new Uint8Array(await res.arrayBuffer()));
    };
    const collection = await getJson(METEOSCHWEIZ_STAC);
    const assets = Object.values(collection.assets || {});
    const meta = (part) => assets.find((a) => /\.csv$/i.test(a.href || '') && a.href.toLowerCase().includes(part))?.href;
    const stationsUrl = meta('meta_stations');
    const paramsUrl = meta('meta_parameters');
    if (!stationsUrl || !paramsUrl) throw new Error('MeteoSchweiz: Beschreibungsdateien (Stationen, Parameter) nicht gefunden');
    const data = [];
    let next = `${METEOSCHWEIZ_STAC}/items?limit=100`;
    for (let page = 0; next && page < 20; page++) {
      const items = await getJson(next);
      for (const item of items.features || []) {
        for (const a of Object.values(item.assets || {})) if (/\.csv$/i.test(a.href || '')) data.push(await getText(a.href));
      }
      next = (items.links || []).find((l) => l.rel === 'next')?.href || null;
    }
    if (!data.length) throw new Error('MeteoSchweiz: keine Beobachtungsdateien gefunden');
    return { ...importMeteoSchweiz({ stations: await getText(stationsUrl), parameters: await getText(paramsUrl), data }), files: data.length };
  }

  const stationsQuery = (table) => db.prepare(`
    SELECT s.source, s.id, s.name, s.lat, s.lon, s.elevation,
           COUNT(*) AS years, GROUP_CONCAT(o.doy) AS doys, MIN(o.year) AS first, MAX(o.year) AS last
    FROM ${table} o JOIN pheno_stations s ON s.source = o.source AND s.id = o.station_id
    WHERE o.species = ? AND o.year BETWEEN ? AND ?
      AND s.lat BETWEEN ? AND ? AND s.lon BETWEEN ? AND ?
    GROUP BY s.source, s.id`);
  const stationsOf = { colour: stationsQuery('pheno_obs'), leafout: stationsQuery('pheno_leafout') };

  /**
   * Reference date for `species` at a place: day of year at the given altitude
   * (null elevation: no altitude shift), with the stations used. `phase`:
   * 'colour' (start of autumn colouring, default) or 'leafout'. `year`: only
   * that year's observations (one station is enough), instead of the mean of
   * the last ten complete years. Null when no station with enough years is near.
   */
  function reference(species, { lat, lon, elevation = null }, { phase = 'colour', year = null } = {}) {
    const key = `${version}|${phase}|${year}|${species}|${lat.toFixed(3)}|${lon.toFixed(3)}|${elevation}`;
    if (memo.has(key)) return memo.get(key);
    const to = year ?? new Date(now()).getUTCFullYear() - 1;
    const from = year ?? to - PERIOD_YEARS + 1;
    const perHundred = phase === 'leafout' ? LEAFOUT_DAYS_PER_100M : -DAYS_PER_100M;
    const dLat = MAX_DISTANCE_KM / 111;
    const dLon = MAX_DISTANCE_KM / (111 * Math.cos((lat * Math.PI) / 180));
    const candidates = stationsOf[phase].all(species, from, to, lat - dLat, lat + dLat, lon - dLon, lon + dLon)
      .filter((s) => s.years >= (year ? 1 : MIN_YEARS))
      .map((s) => {
        const doys = s.doys.split(',').map(Number).sort((a, b) => a - b);
        const median = doys[Math.floor(doys.length / 2)];
        const kept = doys.filter((d) => Math.abs(d - median) <= 21); // drop obvious misreports
        const mean = kept.reduce((a, b) => a + b, 0) / kept.length;
        const km = distanceM({ lat, lon }, { lat: s.lat, lon: s.lon }) / 1000;
        const dh = Number.isFinite(elevation) && Number.isFinite(s.elevation) ? elevation - s.elevation : 0;
        const eff = Math.hypot(km, (dh / 100) * KM_PER_100M);
        const adjust = Math.max(-MAX_ALTITUDE_ADJUST, Math.min(MAX_ALTITUDE_ADJUST, (dh / 100) * perHundred));
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
        phase,
        year,
        label: `${year ? `Beobachtet ${year}` : 'Referenz'}: ${src}-Station ${main.name}, ${Math.round(main.km)} km` +
          (Number.isFinite(main.elevation) ? `, ${Math.round(main.elevation)} m` : '') +
          (year ? '' : `, Mittel ${first}–${last}`) +
          (candidates.length > 1 ? ` (+${candidates.length - 1} weitere)` : ''),
      };
    }
    memo.set(key, result);
    if (memo.size > 500) memo.delete(memo.keys().next().value);
    return result;
  }

  /**
   * Leaf-out at a place in `year`: this year's observations nearby if any have come in
   * (DWD immediate reporters, MeteoSchweiz), else the ten-year mean. The first species
   * of `speciesList` with data counts (the frost-tender ones of the spot, then beech).
   * → { species, doy, year (observed year or null), label } or null.
   */
  function leafOut(speciesList, place, year) {
    for (const sci of speciesList) {
      const current = reference(sci, place, { phase: 'leafout', year });
      if (current) return current;
      const mean = reference(sci, place, { phase: 'leafout' });
      if (mean) return mean;
    }
    return null;
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
    leafout: db.prepare('SELECT COUNT(*) AS n FROM pheno_leafout').get().n,
    species: db.prepare('SELECT species, COUNT(*) AS n, MIN(year) AS first, MAX(year) AS last FROM pheno_obs GROUP BY species ORDER BY species').all(),
    imported: Object.fromEntries(db.prepare("SELECT key, value FROM pheno_meta WHERE key LIKE 'imported:%'").all()
      .map((r) => [r.key.slice(9), r.value])),
  });

  return { importDwd, importGeneric, importMeteoSchweiz, syncDwd, syncMeteoSchweiz, reference, leafOut, forPlace, status };
}

module.exports = {
  createPhenoRef, parseTable, parseDwdStations, parseDwdPlants, parseDwdPhases, parseDwdPhaseKinds, parseDwdObservations, parseGeneric,
  parseMeteoSchweiz, speciesFromFileName, decodeText, doyOfDate, DWD_BASE, METEOSCHWEIZ_STAC,
};
