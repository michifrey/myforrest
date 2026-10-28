'use strict';

/*
 * Landschaft im Wandel (landschaft.html): official maps through time and a report per place, from the layers of
 * geo.admin.ch (found by name in its capabilities, like the panel «Ebenen», routes/layers.js), the glacier
 * inventories and GLAMOS series of this server, and the spots in the region. The climate part of the report comes
 * from the climate dossier (/api/klima), which the page asks for itself.
 *
 *   GET /api/landschaft/karten               the maps through time (with the years of swisstopo's «Zeitreise» of the
 *                                            Landeskarte and of the aerial images), the layers per theme and the
 *                                            years of the glacier inventories (outlines from /api/glaciers)
 *   GET /api/landschaft/bericht?lat&lon      what the layers, the inventories and the spots say about a place
 *   GET /api/landschaft/bericht.pdf?lat&lon&ort   the report as a PDF (A4), with map excerpts of the place per theme
 *   GET /api/landschaft/suche?q              places by name (SearchServer of geo.admin.ch) or coordinates (WGS84, LV95)
 */

// Maps through time, in this order; a stop is offered when its layer exists (the Landeskarte always).
const TIMELINE = [
  {
    id: 'eiszeit', match: /^ch\.swisstopo\.geologie-eiszeit-lgm-raster$/, when: 'vor rund 24 000 Jahren', title: 'Letzte Eiszeit',
    text: 'Grösste Ausdehnung der Gletscher in der letzten Eiszeit: Eis bedeckt fast das ganze Mittelland (swisstopo, Karte des letzteiszeitlichen Maximums 1:500 000).',
  },
  {
    id: 'dufour', match: /^ch\.swisstopo\.hiks-dufour$/, when: 'um 1850', title: 'Dufourkarte',
    text: 'Die erste amtliche Karte der Schweiz (1845–1865), aufgenommen am Ende der Kleinen Eiszeit, als die Gletscher am grössten waren.',
  },
  {
    id: 'siegfried', match: /^ch\.swisstopo\.hiks-siegfried$/, when: 'um 1900', title: 'Siegfriedkarte',
    text: 'Topographischer Atlas der Schweiz (1870–1949): Gletscher, Wald und Siedlungen vor dem grossen Wandel des 20. Jahrhunderts.',
  },
  {
    id: 'zeitreise', wmts: 'ch.swisstopo.zeitreihen', ext: 'png', title: 'Zeitreise der Landeskarte',
    text: 'Die Landeskarten von swisstopo, wie sie im gewählten Jahr galten: Gletscher, Wald, Siedlungen und Strassen Jahr für Jahr. Vor 1964 decken sie die Schweiz nicht überall ab.',
  },
  {
    id: 'luftbild', wmts: 'ch.swisstopo.swissimage-product', ext: 'jpeg', title: 'Historische Luftbilder',
    text: 'SWISSIMAGE Zeitreise: die Orthofotos von swisstopo aus den Befliegungen seit 1926. Jede Kachel zeigt den Flug, der den grössten Teil liefert; an den Rändern der Flugblöcke mischen sich die Jahre.',
  },
  { id: 'heute', base: true, when: 'heute', title: 'Landeskarte', text: 'Die aktuelle Landeskarte von swisstopo.' },
  {
    id: 'wald-heute', match: /^ch\.bafu\.wald-vegetationshoehenstufen_1975$/, when: 'heute', title: 'Höhenstufen des Waldes',
    text: 'Vegetationshöhenstufen im Klima der Referenzperiode (BAFU): wo welche Waldgesellschaften wachsen.',
  },
  {
    id: 'wald-2085-wt', match: /^ch\.bafu\.wald-vegetationshoehenstufen_2085_weniger_trocken$/, when: 'um 2085, weniger trocken', title: 'Höhenstufen 2085 (RCP4.5)',
    text: 'Modellierte Höhenstufen für 2070–2099 bei mittleren Emissionen (RCP4.5, BAFU): die Stufen steigen den Hang hinauf.',
  },
  {
    id: 'wald-2085-t', match: /^ch\.bafu\.wald-vegetationshoehenstufen_2085_trocken$/, when: 'um 2085, trocken', title: 'Höhenstufen 2085 (RCP8.5)',
    text: 'Modellierte Höhenstufen für 2070–2099 bei hohen Emissionen (RCP8.5, BAFU): deutlich trockener, in tiefen Lagen neue Stufen.',
  },
];

// Themes of the report, each with the layers asked at the place (by name; `prefer` first, at most `max`).
const THEMES = [
  {
    id: 'klima', title: 'Klima', max: 4,
    match: /klimanormwerte|klimaszenarien|ch2018|ch2025/i,
    prefer: ['ch.meteoschweiz.klimanormwerte-temperatur_aktuelle_periode', 'ch.meteoschweiz.klimanormwerte-niederschlag_aktuelle_periode'],
  },
  {
    id: 'wasser', title: 'Gletscher und Wasser', max: 6,
    match: /gletscher|glacier|abfluss|niedrigwasser|wasserhaushalt|hydrologischer-atlas|trockenheit|grundwasser|schneehoehe/i,
    prefer: [],
  },
  {
    id: 'wald', title: 'Wald', max: 6,
    match: /vegetationshoehenstufen|landesforstinventar-(waldmischungsgrad|vegetationshoehenmodell|baumarten)|waldstandort|schutzwald/i,
    prefer: ['ch.bafu.wald-vegetationshoehenstufen_1975', 'ch.bafu.wald-vegetationshoehenstufen_2085_weniger_trocken', 'ch.bafu.wald-vegetationshoehenstufen_2085_trocken', 'ch.bafu.landesforstinventar-waldmischungsgrad', 'ch.bafu.landesforstinventar-vegetationshoehenmodell'],
  },
  {
    id: 'boden', title: 'Landwirtschaft und Boden', max: 6,
    match: /arealstatistik|fruchtfolgeflaechen|bodeneignung|landwirtschaftliche-zonengrenzen|bewaesserung|landwirtschaftliche-nutzungsflaechen/i,
    prefer: ['ch.bfs.arealstatistik', 'ch.bfs.arealstatistik-bodenbedeckung', 'ch.blw.landwirtschaftliche-zonengrenzen'],
  },
];

const { TAGS } = require('../tags');

const RADIUS_KM = 5;

// swisstopo's «Zeitreise» (the Landeskarte of each year) and the aerial images of each flight: WMTS layers with a
// time dimension; their years and tile addresses are in the WMTS capabilities.
const ZEITREISE_CAPABILITIES = 'https://wmts.geo.admin.ch/EPSG/3857/1.0.0/WMTSCapabilities.xml';
const SEARCH = 'https://api3.geo.admin.ch/rest/services/api/SearchServer';
const { wgs84ToLv95 } = require('../lv95');
const { renderReportPdf } = require('../landschaft-pdf');

// Map excerpts of the PDF report: width of the area (m) and size (px, twice the size on paper).
const PDF_MAPS = {
  overview: { widthM: 6000, px: [990, 420] },
  klima: { widthM: 30000, px: [990, 340] },
  wasser: { widthM: 8000, px: [990, 340] },
  wald: { widthM: 5000, px: [990, 340] },
  boden: { widthM: 5000, px: [990, 340] },
};
const BASE_MAPS = ['ch.swisstopo.pixelkarte-farbe', 'ch.swisstopo.pixelkarte-grau'];
/** A file name without umlauts and spaces: «Zürich (ZH)» → «zuerich-zh». */
const slug = (s) => String(s).toLowerCase().replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').normalize('NFD')
  .replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9.]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);

// What a hit of the SearchServer is, by its `origin`.
const ORIGINS = {
  gg25: 'Gemeinde', district: 'Bezirk', kantone: 'Kanton', zipcode: 'Postleitzahl', gazetteer: 'Ort',
  sn25: 'Ort', address: 'Adresse', parcel: 'Parzelle',
};

const Coords = require('../../public/coords.js');
const KINDS = { lv95: 'LV95', lv03: 'LV03', wgs84: 'WGS84', mgrs: 'MGRS' };
/**
 * Coordinates typed into the search, in the formats map.geo.admin.ch reads (public/coords.js): WGS84 in decimal
 * degrees or with minutes and seconds, LV95, LV03, MGRS. Null when the text is none of them or (for plain numbers)
 * the place is not in Switzerland.
 */
function parseCoordinates(text) {
  const p = Coords.parse(text);
  return p ? { lat: p.lat, lon: p.lon, label: `${KINDS[p.kind]} ${String(text).trim()}` } : null;
}

/** A label of the SearchServer as text: «<b>Zürich</b> (ZH)» → «Zürich (ZH)». */
const plain = (html) => String(html || '').replace(/<[^>]*>/g, '').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/\s+/g, ' ').trim();
const DAY = 24 * 3600000;

/**
 * A WMTS layer with a time dimension in capabilities: its time values (YYYY or YYYYMMDD, oldest first) and the tile
 * address as a Leaflet template ({time}, {z}, {x}, {y}); null when the layer is not there.
 */
function wmtsLayer(xml, layer) {
  for (const block of xml.split(/<Layer>/).slice(1)) {
    const id = block.match(/<ows:Identifier>([^<]*)<\/ows:Identifier>/)?.[1];
    if (id !== layer) continue;
    const dim = block.match(/<Dimension>([\s\S]*?)<\/Dimension>/)?.[1] || '';
    const times = [...new Set([...dim.matchAll(/<Value>(\d{4}(?:\d{4})?)<\/Value>/g)].map((m) => m[1]))].sort();
    const raw = block.match(/<ResourceURL[^>]*resourceType="tile"[^>]*template="([^"]+)"/)?.[1]
      || block.match(/<ResourceURL[^>]*template="([^"]+)"[^>]*resourceType="tile"/)?.[1] || null;
    const template = raw && raw.replace(/&amp;/g, '&').replace('{Time}', '{time}').replace('{TileMatrixSet}', '3857')
      .replace('{TileMatrix}', '{z}').replace('{TileCol}', '{x}').replace('{TileRow}', '{y}');
    return { times, template };
  }
  return null;
}
const yearOf = (time) => Number(String(time).slice(0, 4));

function pick(layers, theme) {
  const hits = layers.filter((l) => theme.match.test(l.name));
  const rank = (l) => { const i = theme.prefer.indexOf(l.name); return i < 0 ? 99 : i; };
  return hits.sort((a, b) => rank(a) - rank(b) || a.title.localeCompare(b.title, 'de')).slice(0, theme.max);
}

module.exports = function registerLandschaft(app, {
  db, layers, glaciers = null, glamos = null, klima = null, fetchImpl = fetch, now = () => Date.now(),
  zeitreiseUrl = (process.env.ZEITREISE_WMTS_URL ?? ZEITREISE_CAPABILITIES) || null,
  searchUrl = (process.env.ORTSSUCHE_URL ?? SEARCH) || null,
}) {
  let wmts = { at: 0, layers: {} };
  /** The time layers of the timeline from the WMTS capabilities, read once a day; the last good ones when it fails. */
  async function timeLayers() {
    if (!zeitreiseUrl || (Object.keys(wmts.layers).length && now() - wmts.at < DAY)) return wmts.layers;
    try {
      const r = await fetchImpl(zeitreiseUrl, { signal: AbortSignal.timeout(40000) });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const xml = await r.text();
      const found = {};
      for (const t of TIMELINE.filter((x) => x.wmts)) {
        const l = wmtsLayer(xml, t.wmts);
        if (l?.times.length) found[t.wmts] = l;
      }
      if (Object.keys(found).length) wmts = { at: now(), layers: found };
    } catch { /* keep what we had */ }
    return wmts.layers;
  }

  const hasCol = (table, col) => db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === col);
  const layerJson = (l) => ({ name: l.name, title: l.title, url: l.url, attribution: l.attribution, legend: l.legend });

  app.get('/api/landschaft/karten', async (req, res) => {
    const [all, timed] = await Promise.all([layers.geoadminLayers(), timeLayers()]);
    const timeline = [];
    for (const t of TIMELINE) {
      if (t.wmts) {
        const w = timed[t.wmts];
        if (!w) continue;
        // One entry per year (aerial images list several flights of a year: the last one counts).
        const byYear = new Map(w.times.map((time) => [yearOf(time), time]));
        const years = [...byYear].map(([year, time]) => ({ year, time }));
        const tiles = w.template || `https://wmts.geo.admin.ch/1.0.0/${t.wmts}/default/{time}/3857/{z}/{x}/{y}.${t.ext}`;
        timeline.push({
          id: t.id, when: `${years[0].year}–${years[years.length - 1].year}`, title: t.title, text: t.text, base: false,
          zeitreise: { tiles, layer: t.wmts, years, attribution: '© swisstopo' },
        });
        continue;
      }
      const layer = t.base ? null : all.find((l) => t.match.test(l.name));
      if (!t.base && !layer) continue;
      timeline.push({ id: t.id, when: t.when, title: t.title, text: t.text, base: Boolean(t.base), ...(layer ? { layer: layerJson(layer) } : {}) });
    }
    res.set('Cache-Control', 'public, max-age=3600');
    // The glacier inventories of this server (outlines from /api/glaciers), when there are any.
    const glacierYears = glaciers?.enabled() ? glaciers.years() : [];
    res.json({
      timeline,
      themes: THEMES.map((t) => ({ id: t.id, title: t.title, layers: pick(all, t).map(layerJson) })),
      glaciers: glacierYears.length ? { years: glacierYears } : null,
    });
  });

  /** Spots, photos, damage and neophytes within the radius: what people saw there. */
  function observed(lat, lon) {
    const dLat = RADIUS_KM / 111.32;
    const dLon = RADIUS_KM / (111.32 * Math.cos((lat * Math.PI) / 180));
    const visible = [hasCol('photos', 'hidden_at') ? 'p.hidden_at IS NULL' : '1 = 1', hasCol('photos', 'protected') ? 'COALESCE(p.protected, 0) = 0' : '1 = 1'].join(' AND ');
    const box = [lat - dLat, lat + dLat, lon - dLon, lon + dLon];
    const photos = db.prepare(`SELECT COUNT(*) AS n, COUNT(DISTINCT p.spot_id) AS spots, MIN(p.taken_at) AS first, MAX(p.taken_at) AS last
      FROM photos p WHERE ${visible} AND p.lat BETWEEN ? AND ? AND p.lon BETWEEN ? AND ?`).get(...box);
    const tags = db.prepare(`SELECT t.tag, COUNT(DISTINCT p.spot_id) AS spots FROM photo_tags t JOIN photos p ON p.id = t.photo_id
      WHERE ${visible} AND p.lat BETWEEN ? AND ? AND p.lon BETWEEN ? AND ? GROUP BY t.tag ORDER BY spots DESC LIMIT 8`).all(...box);
    const neophytes = db.prepare(`SELECT i.scientific_name AS name, MAX(i.common_name) AS common, COUNT(*) AS n
      FROM identifications i JOIN photos p ON p.id = i.photo_id
      WHERE ${visible} AND i.neophyte = 1 AND p.lat BETWEEN ? AND ? AND p.lon BETWEEN ? AND ?
      GROUP BY i.scientific_name ORDER BY n DESC LIMIT 6`).all(...box);
    const year = (ms) => (ms ? new Date(ms).getUTCFullYear() : null);
    return {
      radiusKm: RADIUS_KM, photos: photos.n, spots: photos.spots, firstYear: year(photos.first), lastYear: year(photos.last),
      tags: tags.map((t) => ({ tag: t.tag, label: TAGS[t.tag] || t.tag, spots: t.spots })), neophytes,
    };
  }

  /** lat and lon of a request, or null (after answering 400). */
  function placeOf(req, res) {
    const lat = Number(req.query.lat);
    const lon = Number(req.query.lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) {
      res.status(400).json({ error: 'lat und lon angeben' });
      return null;
    }
    return { lat, lon };
  }

  /** What the layers of each theme, the glacier inventories and the spots say about a place. */
  async function report(lat, lon, all) {
    const chosen = THEMES.map((t) => ({ theme: t, layers: pick(all, t) }));
    // One identify per theme (geo.admin.ch answers for several layers at once), all at the same time.
    const answers = await Promise.all(chosen.map(({ layers: ls }) => layers.identify(lat, lon, ls.map((l) => l.name))));
    const themes = chosen.map(({ theme, layers: ls }, k) => ({
      id: theme.id,
      title: theme.title,
      layers: ls.map(layerJson),
      items: answers[k].map((a) => ({ layer: a.name, title: a.title || ls.find((l) => l.name === a.name)?.title || a.name, attributes: a.attributes })),
    }));
    let glacier = null;
    if (glaciers?.enabled()) {
      const g = glaciers.at(lat, lon, { radiusM: RADIUS_KM * 1000 });
      if (g) glacier = { ...g, length: glamos?.forGlacier(g) || null };
    }
    return { lat, lon, themes, glacier, observed: observed(lat, lon) };
  }

  app.get('/api/landschaft/bericht', async (req, res) => {
    const at = placeOf(req, res);
    if (!at) return;
    res.json(await report(at.lat, at.lon, await layers.geoadminLayers()));
  });

  /** A WMS map of geo.admin.ch (PNG) for a box in LV95, or null. */
  async function getMap(layer, box, [w, h]) {
    const q = new URLSearchParams({
      SERVICE: 'WMS', VERSION: '1.3.0', REQUEST: 'GetMap', LAYERS: layer.name, STYLES: '', CRS: 'EPSG:2056',
      BBOX: box.join(','), WIDTH: String(w), HEIGHT: String(h), FORMAT: 'image/png', TRANSPARENT: 'true',
    });
    try {
      const r = await fetchImpl(`${layer.url}${layer.url.includes('?') ? '&' : '?'}${q}`, { signal: AbortSignal.timeout(20000) });
      if (!r.ok || !/image/.test(r.headers.get('content-type') || '')) return null;
      return Buffer.from(await r.arrayBuffer());
    } catch {
      return null;
    }
  }

  /**
   * A map excerpt around the place for the PDF: the Landeskarte, a theme layer over it (70 % opaque) and a mark at
   * the place, as JPEG; null when neither map came.
   */
  async function mapExcerpt(lat, lon, { widthM, px }, base, overlay) {
    const sharp = require('sharp');
    const [e, n] = wgs84ToLv95(lat, lon);
    const half = [widthM / 2, (widthM / 2) * (px[1] / px[0])];
    const box = [e - half[0], n - half[1], e + half[0], n + half[1]].map((v) => Math.round(v));
    const [b, o] = await Promise.all([base ? getMap(base, box, px) : null, overlay ? getMap(overlay, box, px) : null]);
    if (!b && !o) return null;
    try {
      const layersOn = [];
      if (o) {
        // 70 % of the theme layer's own transparency.
        const faded = await sharp(o).ensureAlpha().resize(px[0], px[1], { fit: 'fill' }).linear([1, 1, 1, 0.7], [0, 0, 0, 0]).png().toBuffer();
        layersOn.push({ input: faded });
      }
      const [cx, cy] = [px[0] / 2, px[1] / 2];
      layersOn.push({ input: Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${px[0]}" height="${px[1]}">
        <circle cx="${cx}" cy="${cy}" r="13" fill="none" stroke="#fff" stroke-width="7"/>
        <circle cx="${cx}" cy="${cy}" r="13" fill="none" stroke="#c0392b" stroke-width="4"/>
        <circle cx="${cx}" cy="${cy}" r="3.5" fill="#c0392b"/></svg>`) });
      const ground = b ? sharp(b).resize(px[0], px[1], { fit: 'fill' }) : sharp({ create: { width: px[0], height: px[1], channels: 3, background: '#ffffff' } });
      return await ground.flatten({ background: '#ffffff' }).composite(layersOn).jpeg({ quality: 82 }).toBuffer();
    } catch {
      return null;
    }
  }

  app.get('/api/landschaft/bericht.pdf', async (req, res) => {
    const at = placeOf(req, res);
    if (!at) return;
    const name = String(req.query.ort || '').trim().slice(0, 120) || null;
    const all = await layers.geoadminLayers();
    const base = BASE_MAPS.map((b) => all.find((l) => l.name === b)).find(Boolean) || null;
    const km = (m) => `${String(m / 1000).replace('.', ',')} km`;
    const [r, d, ...pictures] = await Promise.allSettled([
      report(at.lat, at.lon, all),
      klima ? klima.dossier(req, at) : Promise.reject(new Error('Klima-Dossier nicht eingerichtet')),
      mapExcerpt(at.lat, at.lon, PDF_MAPS.overview, base, null),
      // A theme without a layer gets no map (the Landeskarte alone is the overview).
      ...THEMES.map((t) => (pick(all, t)[0] ? mapExcerpt(at.lat, at.lon, PDF_MAPS[t.id], base, pick(all, t)[0]) : null)),
    ]);
    if (r.status !== 'fulfilled') return res.status(502).json({ error: `Bericht nicht verfügbar: ${r.reason.message}` });
    const png = (i) => (pictures[i].status === 'fulfilled' ? pictures[i].value : null);
    const baseName = base ? `${base.title} (${base.name})` : 'ohne Landeskarte';
    const maps = { overview: png(0) && { png: png(0), caption: `Lage: ${baseName}, Ausschnitt ${km(PDF_MAPS.overview.widthM)} · © swisstopo` } };
    THEMES.forEach((t, i) => {
      const layer = pick(all, t)[0];
      if (layer && png(i + 1)) maps[t.id] = { png: png(i + 1), caption: `Karte: ${layer.title} (${layer.name}) über der Landeskarte, Ausschnitt ${km(PDF_MAPS[t.id].widthM)} · ${layer.attribution || '© geo.admin.ch'}` };
    });
    const q = new URLSearchParams({ lat: at.lat, lon: at.lon, ...(name ? { ort: name } : {}) });
    const pdf = await renderReportPdf({
      place: { ...at, name }, report: r.value,
      dossier: d.status === 'fulfilled' ? d.value : null, dossierError: d.status === 'fulfilled' ? d.value.climateError : d.reason.message,
      maps, url: `${req.protocol}://${req.get('host')}/landschaft.html#bericht?${q}`,
    });
    const file = `landschaft-im-wandel-${slug(name || `${at.lat.toFixed(4)}-${at.lon.toFixed(4)}`)}.pdf`;
    res.set('Content-Disposition', `inline; filename="${file}"`).type('application/pdf').send(pdf);
  });


  // Places by name or coordinates; answers kept for an hour (people type the same names).
  const searches = new Map();
  app.get('/api/landschaft/suche', async (req, res) => {
    const q = String(req.query.q || '').trim().slice(0, 100);
    if (q.length < 2) return res.status(400).json({ error: 'Mindestens zwei Zeichen eingeben' });
    const coords = parseCoordinates(q);
    if (coords) return res.json({ results: [{ ...coords, kind: 'Koordinaten' }] });
    if (!searchUrl) return res.json({ results: [], error: 'Ortssuche nicht eingerichtet' });
    const key = q.toLowerCase();
    const hit = searches.get(key);
    if (hit && now() - hit.at < 3600000) return res.json({ results: hit.results });
    try {
      const params = new URLSearchParams({ searchText: q, type: 'locations', sr: '4326', limit: '8' });
      const r = await fetchImpl(`${searchUrl}?${params}`, { signal: AbortSignal.timeout(10000) });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const results = ((await r.json()).results || []).map(({ attrs = {} }) => ({
        label: plain(attrs.label), kind: ORIGINS[attrs.origin] || 'Ort', lat: Number(attrs.lat), lon: Number(attrs.lon),
      })).filter((x) => x.label && Number.isFinite(x.lat) && Number.isFinite(x.lon));
      if (searches.size > 500) searches.clear();
      searches.set(key, { at: now(), results });
      res.json({ results });
    } catch (err) {
      res.json({ results: [], error: `Ortssuche nicht verfügbar: ${err.message}` });
    }
  });
};

module.exports.TIMELINE = TIMELINE;
module.exports.wmtsLayer = wmtsLayer;
module.exports.THEMES = THEMES;
module.exports.parseCoordinates = parseCoordinates;
