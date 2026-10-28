'use strict';

/*
 * Map layers from external sources for the panel "Ebenen" of the main map: forest and forest fire, population,
 * land use, traffic, from the WMS of geo.admin.ch (found by name in its capabilities, read once a day), city and
 * canton services for their area (Zürich's tree register, Geneva's canopy and heat), European forest fires
 * (EFFIS) and, with a key, active fires of NASA FIRMS. A click on the map asks what the switched-on layers say
 * there: geo.admin.ch layers through its identify service, others through WMS GetFeatureInfo (JSON).
 *
 *   GET /api/layers                  groups of layers: { id, title, layers: [{ id, url, name, title, attribution, bbox, legend }] }
 *   GET /api/layers/info?lat&lon&layers=id,id   what the layers say at a point
 *   GET /api/layers/geoadmin?q=…|ids=a,b  any layer of geo.admin.ch, by words (as the layer search of
 *                                    map.geo.admin.ch) or by name (layers of a shared link); ids `ga:<name>`
 *   GET /api/layers/hoehe?lat&lon    height of a point: swissALTI3D through geo.admin.ch in Switzerland, else the
 *                                    terrain model of Open-Meteo
 */

const { parseCapabilities } = require('../dwd');

const GEOADMIN_WMS = 'https://wms.geo.admin.ch/';
const IDENTIFY = 'https://api3.geo.admin.ch/rest/services/api/MapServer/identify';
const HEIGHT = 'https://api3.geo.admin.ch/rest/services/height';
const { wgs84ToLv95, inLv95Area } = require('../lv95');
const TTL = 24 * 3600000;
const PER_GROUP = 30;

// Groups of geo.admin.ch layers, by name. `prefer`: shown first (the most useful layer of a theme).
const GROUPS = [
  {
    id: 'wald', title: 'Wald und Waldbrand',
    match: /waldbrand|silvaprotect|schutzwald|landesforstinventar|waldreservat|vegetationshoehen|waldmischung|wald-|waldflaeche|waldstandort/i,
    prefer: ['ch.bafu.gefahren-waldbrand_warnung', 'ch.bafu.landesforstinventar-waldmischungsgrad', 'ch.bafu.landesforstinventar-vegetationshoehenmodell'],
  },
  {
    id: 'bevoelkerung', title: 'Bevölkerung',
    match: /bevoelkerung|statpop|volkszaehlung|einwohner|haushalte|bevoelkerungsdichte/i,
    prefer: ['ch.bfs.volkszaehlung-bevoelkerungsstatistik_einwohner'],
  },
  {
    id: 'nutzung', title: 'Bodennutzung',
    match: /arealstatistik|bodennutzung|bodenbedeckung|bauzonen|landwirtschaftliche-zonengrenzen|nutzungsplanung|fruchtfolgeflaechen/i,
    prefer: ['ch.bfs.arealstatistik', 'ch.bfs.arealstatistik-bodenbedeckung', 'ch.are.bauzonen'],
  },
  {
    id: 'verkehr', title: 'Verkehr',
    match: /verkehrszaehlung|strassenverkehr|gueteklassen|belastung-personenverkehr|belastung-gueterverkehr|strassenlaerm|verkehrsnetz/i,
    prefer: ['ch.are.belastung-personenverkehr-strasse', 'ch.are.gueteklassen_oev', 'ch.bafu.laerm-strassenlaerm_tag'],
  },
];

// Regional services: every layer is offered, only where the map is (bbox: west, south, east, north).
const DEFAULT_REGIONAL = [
  {
    url: 'https://www.ogd.stadt-zuerich.ch/wms/geoportal/Baumkataster', group: 'Bäume Stadt Zürich', bbox: [8.44, 47.32, 8.63, 47.44],
    attribution: '© Grün Stadt Zürich, Baumkataster',
  },
  {
    url: 'https://raster.sitg.ge.ch/arcgis/services/CLIMAT_ILOT_CHALEUR_4H00_P0_2020/MapServer/WMSServer', group: 'Stadtklima und Bäume Genf (SITG)',
    bbox: [5.95, 46.12, 6.32, 46.37], attribution: '© SITG / État de Genève',
  },
  {
    url: 'https://vector.sitg.ge.ch/arcgis/services/SIPV_ICA_MNC_2023/MapServer/WMSServer', group: 'Stadtklima und Bäume Genf (SITG)',
    bbox: [5.95, 46.12, 6.32, 46.37], attribution: '© SITG / État de Genève',
  },
  {
    url: 'https://maps.effis.emergency.copernicus.eu/effis', group: 'Waldbrände Europa (EFFIS)', bbox: [-25, 34, 45, 72],
    attribution: '© European Forest Fire Information System (EFFIS), Copernicus',
  },
];

module.exports = function registerLayers(app, {
  fetchImpl = fetch, now = () => Date.now(),
  geoadminUrl = (process.env.EBENEN_WMS_URL ?? GEOADMIN_WMS) || null,
  identifyUrl = (process.env.EBENEN_IDENTIFY_URL ?? IDENTIFY) || null,
  regional = process.env.EBENEN_REGIONAL ? JSON.parse(process.env.EBENEN_REGIONAL) : DEFAULT_REGIONAL,
  firmsKey = process.env.FIRMS_MAP_KEY || '',
  heightUrl = (process.env.EBENEN_HOEHE_URL ?? HEIGHT) || null, elevation = null,
}) {
  const sources = [
    ...(geoadminUrl ? [{ url: geoadminUrl, geoadmin: true, attribution: '© geo.admin.ch' }] : []),
    ...regional,
    ...(firmsKey ? [{
      url: `https://firms.modaps.eosdis.nasa.gov/mapserver/wms/fires/${firmsKey}/`, group: 'Aktive Feuer (NASA FIRMS)',
      attribution: 'NASA FIRMS (MODIS, VIIRS)', match: /fires_(viirs|modis)/i,
    }] : []),
  ];
  let cache = { at: 0, groups: null, errors: [], byId: new Map(), all: [] };

  async function capabilities(url) {
    const sep = url.includes('?') ? '&' : '?';
    const res = await fetchImpl(`${url}${sep}SERVICE=WMS&VERSION=1.3.0&REQUEST=GetCapabilities&lang=de`, { signal: AbortSignal.timeout(40000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const xml = await res.text();
    return { layers: parseCapabilities(xml), service: xml.match(/<Service>[\s\S]*?<Title>([^<]*)<\/Title>/)?.[1]?.trim() || null };
  }
  const legendOf = (src, name) => `${src.url}${src.url.includes('?') ? '&' : '?'}SERVICE=WMS&VERSION=1.3.0&REQUEST=GetLegendGraphic&FORMAT=image/png&SLD_VERSION=1.1.0&LAYER=${encodeURIComponent(name)}&lang=de`;

  async function load() {
    const groups = new Map();
    const errors = [];
    const byId = new Map();
    // Every layer of geo.admin.ch, for other pages that pick their own (routes/landschaft.js).
    const all = [];
    const add = (groupId, title, layer) => {
      if (!groups.has(groupId)) groups.set(groupId, { id: groupId, title, layers: [] });
      const g = groups.get(groupId);
      if (g.layers.some((l) => l.url === layer.url && l.name === layer.name)) return;
      layer.id = `${groupId}:${byId.size}`;
      g.layers.push(layer);
      byId.set(layer.id, layer);
    };
    for (const src of sources) {
      let caps;
      try {
        caps = await capabilities(src.url);
      } catch (err) {
        errors.push(`${new URL(src.url).hostname}: ${err.message}`);
        continue;
      }
      if (src.geoadmin) {
        all.push(...caps.layers.map((l) => ({ url: src.url, name: l.name, title: l.title, attribution: src.attribution, legend: legendOf(src, l.name) })));
        for (const g of GROUPS) {
          const hits = caps.layers.filter((l) => g.match.test(l.name));
          const rank = (l) => { const i = g.prefer.indexOf(l.name); return i < 0 ? 99 : i; };
          hits.sort((a, b) => rank(a) - rank(b) || a.title.localeCompare(b.title, 'de'));
          for (const l of hits.slice(0, PER_GROUP)) {
            add(g.id, g.title, { url: src.url, name: l.name, title: l.title, attribution: src.attribution, bbox: null, legend: legendOf(src, l.name), identify: 'geoadmin' });
          }
        }
      } else {
        const id = src.group.toLowerCase().normalize('NFD').replace(/[^a-z]+/g, '-').replace(/^-|-$/g, '');
        // ArcGIS names its layers 0, 1 …: the title says what it is, with the service's title in front.
        for (const l of caps.layers.filter((x) => !src.match || src.match.test(x.name)).slice(0, PER_GROUP)) {
          const title = /^\d+$/.test(l.name) && caps.service && !l.title.includes(caps.service) ? `${caps.service}: ${l.title}` : l.title;
          add(id, src.group, { url: src.url, name: l.name, title, attribution: src.attribution, bbox: src.bbox || null, legend: legendOf(src, l.name), identify: 'wms' });
        }
      }
    }
    const order = ['wald', 'bevoelkerung', 'nutzung', 'verkehr'];
    const list = [...groups.values()].sort((a, b) => ((order.indexOf(a.id) + 1 || 99) - (order.indexOf(b.id) + 1 || 99)) || a.title.localeCompare(b.title, 'de'));
    return { at: now(), groups: list, errors, byId, all };
  }

  let loading = null;
  async function catalogue() {
    if (cache.groups && now() - cache.at < TTL) return cache;
    loading = loading || load().then((c) => {
      // Keep the last good list when every source failed this time.
      if (c.groups.length || !cache.groups) cache = c;
      return cache;
    }).finally(() => { loading = null; });
    return loading;
  }

  app.get('/api/layers', async (req, res) => {
    const c = await catalogue();
    res.set('Cache-Control', 'public, max-age=3600');
    res.json({
      groups: c.groups.map((g) => ({ ...g, layers: g.layers.map(({ identify, ...l }) => ({ ...l, info: Boolean(identify), geoadmin: identify === 'geoadmin' })) })),
      ...(c.errors.length ? { errors: c.errors } : {}),
    });
  });

  // Attributes that say nothing to a person on a map.
  const NOISE = /^(id|objectid|fid|gid|shape|geom|the_geom|label|layerbodid|featureid|bgdi_|x$|y$|e$|n$|lat|lon)/i;
  const clean = (attrs) => Object.entries(attrs || {})
    .filter(([k, v]) => !NOISE.test(k) && v !== null && v !== '' && typeof v !== 'object')
    .slice(0, 10).map(([k, v]) => [k.replace(/_/g, ' '), String(v).slice(0, 120)]);

  app.get('/api/layers/info', async (req, res) => {
    const lat = Number(req.query.lat);
    const lon = Number(req.query.lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) return res.status(400).json({ error: 'lat und lon angeben' });
    const c = await catalogue();
    const layers = String(req.query.layers || '').split(',').map((id) => c.byId.get(id) || geoadminById(c, id)).filter(Boolean).slice(0, 8);
    const items = [];
    const geo = layers.filter((l) => l.identify === 'geoadmin');
    for (const hit of await identify(lat, lon, geo.map((l) => l.name))) {
      const layer = geo.find((l) => l.name === hit.name) || geo[0];
      items.push({ id: layer.id, title: hit.title || layer.title, attributes: hit.attributes });
    }
    for (const l of layers.filter((x) => x.identify === 'wms')) {
      // A 101 × 101 pixel GetMap window of ~200 m around the point, asking for its middle pixel.
      const R = 6378137;
      const x = (lon * Math.PI / 180) * R;
      const y = Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI / 180) / 2)) * R;
      const h = 100;
      const q = new URLSearchParams({
        SERVICE: 'WMS', VERSION: '1.3.0', REQUEST: 'GetFeatureInfo', LAYERS: l.name, QUERY_LAYERS: l.name, CRS: 'EPSG:3857',
        BBOX: `${x - h},${y - h},${x + h},${y + h}`, WIDTH: '101', HEIGHT: '101', I: '50', J: '50', INFO_FORMAT: 'application/json', FEATURE_COUNT: '3',
      });
      try {
        const r = await fetchImpl(`${l.url}${l.url.includes('?') ? '&' : '?'}${q}`, { signal: AbortSignal.timeout(15000) });
        const body = r.ok ? await r.json() : null;
        for (const f of (body?.features || []).slice(0, 2)) {
          const attributes = clean(f.properties);
          if (attributes.length) items.push({ id: l.id, title: l.title, attributes });
        }
      } catch { /* not JSON or no answer */ }
    }
    res.json({ lat, lon, items });
  });

  /**
   * What geo.admin.ch layers (by name) say at a point, through its identify service:
   * [{ name, title, attributes: [[key, value]] }]; nothing when it does not answer.
   */
  async function identify(lat, lon, names) {
    if (!names.length || !identifyUrl) return [];
    const d = 0.002;
    const q = new URLSearchParams({
      geometry: `${lon},${lat}`, geometryType: 'esriGeometryPoint', sr: '4326', tolerance: '5', returnGeometry: 'false', lang: 'de',
      layers: `all:${names.join(',')}`, mapExtent: `${lon - d},${lat - d},${lon + d},${lat + d}`, imageDisplay: '400,400,96',
    });
    try {
      const r = await fetchImpl(`${identifyUrl}?${q}`, { signal: AbortSignal.timeout(15000) });
      const body = r.ok ? await r.json() : { results: [] };
      return (body.results || []).map((f) => ({
        name: f.layerBodId || f.layerId || names[0], title: f.layerName || null, attributes: clean(f.attributes || f.properties),
      })).filter((x) => x.attributes.length);
    } catch {
      return []; // no answer: nothing to say
    }
  }

  /** A layer of geo.admin.ch outside the panel's groups, by id `ga:<name>` (from the search or a shared link). */
  function geoadminById(c, id) {
    if (!String(id).startsWith('ga:')) return null;
    const l = (c.all || []).find((x) => x.name === id.slice(3));
    return l ? { ...l, id, bbox: null, identify: 'geoadmin' } : null;
  }
  const gaJson = ({ identify, ...l }) => ({ ...l, info: Boolean(identify), geoadmin: true });

  app.get('/api/layers/geoadmin', async (req, res) => {
    const c = await catalogue();
    if (req.query.ids !== undefined) {
      const ids = String(req.query.ids).split(',').map((n) => n.trim()).filter((n) => /^[a-z][\w.-]{2,120}$/i.test(n)).slice(0, 20);
      const layers = ids.map((n) => geoadminById(c, `ga:${n}`)).filter(Boolean).map(gaJson);
      return res.json({ layers, missing: ids.filter((n) => !layers.some((l) => l.name === n)) });
    }
    // Every word in the title or the name, the title first.
    const words = String(req.query.q || '').toLowerCase().split(/\s+/).filter((w) => w.length >= 2).slice(0, 5);
    if (!words.length) return res.status(400).json({ error: 'q oder ids angeben' });
    const hit = (l) => words.every((w) => l.title.toLowerCase().includes(w) || l.name.toLowerCase().includes(w));
    const layers = (c.all || []).filter(hit)
      .sort((a, b) => Number(words.every((w) => b.title.toLowerCase().includes(w))) - Number(words.every((w) => a.title.toLowerCase().includes(w))) || a.title.localeCompare(b.title, 'de'))
      .slice(0, 30).map((l) => gaJson({ ...l, id: `ga:${l.name}`, bbox: null, identify: 'geoadmin' }));
    res.set('Cache-Control', 'public, max-age=3600');
    res.json({ layers });
  });

  // Heights of points, kept for a day (people click the same places again).
  const heights = new Map();
  app.get('/api/layers/hoehe', async (req, res) => {
    const lat = Number(req.query.lat);
    const lon = Number(req.query.lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) return res.status(400).json({ error: 'lat und lon angeben' });
    const key = `${lat.toFixed(5)},${lon.toFixed(5)}`;
    const hit = heights.get(key);
    if (hit && now() - hit.at < 86400000) return res.json(hit.value);
    let value = null;
    if (heightUrl && inLv95Area(lat, lon)) {
      try {
        const [e, n] = wgs84ToLv95(lat, lon);
        const r = await fetchImpl(`${heightUrl}?easting=${e.toFixed(1)}&northing=${n.toFixed(1)}&sr=2056`, { signal: AbortSignal.timeout(10000) });
        const h = r.ok ? Number((await r.json()).height) : NaN;
        if (Number.isFinite(h)) value = { elevation: Math.round(h * 10) / 10, source: 'swissALTI3D (swisstopo)' };
      } catch { /* the terrain model below */ }
    }
    if (!value && elevation) {
      try { value = { elevation: await elevation.lookup(lat, lon), source: 'Copernicus DEM (Open-Meteo)' }; } catch { /* none */ }
    }
    if (!value) return res.json({ elevation: null, source: null });
    if (heights.size > 2000) heights.clear();
    heights.set(key, { at: now(), value });
    res.json(value);
  });

  /** All layers of geo.admin.ch from its capabilities (cached with the panel's catalogue). */
  const geoadminLayers = async () => (await catalogue()).all || [];

  return { catalogue, identify, geoadminLayers };
};
