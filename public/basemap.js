'use strict';

/*
 * Base map of the main map. Besides OpenStreetMap, the landeskarte and the aerial photo of swisstopo there is
 * "MyForrest": a vector map (by default OpenFreeMap, OpenMapTiles schema) drawn with MapLibre inside Leaflet
 * (maplibre-gl-leaflet) and repainted in the colours of the app: linen land, moss forest, muted water, white
 * roads, labels in the text colour; dark like the rest of the app at night. The layers of the vector style are
 * recognised by their names (water, wood, grass, building, road …), so another style with the same kind of names
 * works too (BASISKARTE_STIL). Without WebGL, offline or while it loads, OpenStreetMap stands in (its tiles are the
 * ones the offline map keeps).
 * Uses the globals of app.js (map, el, $, state).
 */

(function basemapModule() {
  const STORE = 'myforrest-basemap';
  const SWISS = L.latLngBounds([45.7, 5.7], [47.95, 10.7]);
  let pref = (() => { try { return localStorage.getItem(STORE) || 'myforrest'; } catch { return 'myforrest'; } })();
  const osm = window.osmBase;
  const swisstopo = (layer, ext) => L.tileLayer(`https://wmts.geo.admin.ch/1.0.0/${layer}/default/current/3857/{z}/{x}/{y}.${ext}`, {
    maxZoom: 19, maxNativeZoom: 18, bounds: SWISS, attribution: '© <a href="https://www.swisstopo.admin.ch/">swisstopo</a>',
  });
  const BASES = {
    myforrest: { label: 'MyForrest', layer: null },
    osm: { label: 'OpenStreetMap', layer: osm },
    landeskarte: { label: 'Landeskarte (CH)', layer: swisstopo('ch.swisstopo.pixelkarte-farbe', 'jpeg') },
    luftbild: { label: 'Luftbild (CH)', layer: swisstopo('ch.swisstopo.swissimage', 'jpeg') },
  };
  let current = 'osm';
  let gl = null; // the MapLibre layer once loaded
  let glFailed = false;

  /* ---------- Colours ---------- */

  const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  const dark = () => matchMedia('(prefers-color-scheme: dark)').matches;
  /** The palette of the vector map, from the design tokens (light or dark). */
  function palette() {
    const d = dark();
    return {
      land: css('--bg') || (d ? '#0e1611' : '#f4f0e4'),
      landAlt: css('--bg-deep') || (d ? '#0a110d' : '#e9e3d2'),
      forest: d ? '#1e3324' : '#c9d8b4',
      forestEdge: d ? '#2a4531' : '#b3c79c',
      meadow: d ? '#18261b' : '#e4e8cf',
      farmland: d ? '#16211a' : '#ede8d4',
      residential: d ? '#1a211c' : '#ebe5d6',
      industrial: d ? '#1d211f' : '#e6e0d3',
      building: d ? '#28302a' : '#ddd4c2',
      buildingEdge: d ? '#323b34' : '#cfc4ae',
      water: d ? '#1c3340' : '#c3d9dd',
      waterLine: d ? '#2c5266' : '#a3c3ca',
      ice: d ? '#22323a' : '#eef4f6',
      rock: d ? '#202322' : '#e6e1d6',
      road: d ? '#3a463c' : '#ffffff',
      roadMajor: d ? '#566148' : '#f6e7c4',
      roadCase: d ? '#0b120d' : '#d6cbb3',
      path: d ? '#8a7a55' : '#a8875a',
      rail: d ? '#4a524b' : '#b8afa0',
      boundary: d ? '#6b5f7a' : '#a99bb8',
      text: css('--text') || (d ? '#e8efe2' : '#1b2a1f'),
      textMuted: css('--muted') || (d ? '#a3b19f' : '#5f6b5c'),
      halo: css('--bg') || (d ? '#0e1611' : '#f4f0e4'),
      accent: css('--accent') || '#2f5d34',
    };
  }

  /** What a layer of the vector style shows, from its id and source layer. */
  function kindOf(layer) {
    const s = `${layer.id} ${layer['source-layer'] || ''}`.toLowerCase();
    const has = (...w) => w.some((x) => s.includes(x));
    if (layer.type === 'background') return 'background';
    if (layer.type === 'symbol') return has('water', 'lake', 'river', 'ocean', 'sea') ? 'label-water' : has('place', 'city', 'town', 'village') ? 'label-place' : 'label';
    if (has('water', 'ocean', 'lake', 'river', 'stream', 'canal', 'waterway')) return layer.type === 'line' ? 'water-line' : 'water';
    if (has('glacier', 'ice')) return 'ice';
    if (has('wood', 'forest')) return 'forest';
    if (has('grass', 'meadow', 'park', 'garden', 'golf', 'pitch', 'cemetery')) return 'meadow';
    if (has('farmland', 'farm', 'orchard', 'vineyard', 'crop')) return 'farmland';
    if (has('rock', 'sand', 'scree', 'bare')) return 'rock';
    if (has('building')) return 'building';
    if (has('industrial', 'commercial', 'retail', 'railway_area')) return 'industrial';
    if (has('residential', 'landuse', 'suburb')) return 'residential';
    if (has('rail', 'transit')) return 'rail';
    if (has('boundary', 'admin')) return 'boundary';
    if (has('path', 'track', 'footway', 'cycleway', 'pedestrian', 'steps', 'bridleway')) return 'path';
    if (has('motorway', 'trunk', 'primary', 'highway-major', 'major')) return layer.id.toLowerCase().includes('casing') ? 'road-case' : 'road-major';
    if (has('road', 'highway', 'transportation', 'street', 'secondary', 'tertiary', 'minor', 'service', 'bridge', 'tunnel')) return layer.id.toLowerCase().includes('casing') ? 'road-case' : 'road';
    return null;
  }

  /** The vector style repainted: every layer gets the colour of its kind; unknown ones stay as they are. */
  function theme(style) {
    const p = palette();
    const fill = { forest: p.forest, meadow: p.meadow, farmland: p.farmland, residential: p.residential, industrial: p.industrial, building: p.building, water: p.water, ice: p.ice, rock: p.rock };
    const line = { 'water-line': p.waterLine, road: p.road, 'road-major': p.roadMajor, 'road-case': p.roadCase, path: p.path, rail: p.rail, boundary: p.boundary, forest: p.forestEdge, building: p.buildingEdge };
    const out = JSON.parse(JSON.stringify(style));
    // The credit shows in Leaflet's attribution, taken from the sources of the style.
    for (const src of Object.values(out.sources || {})) if (!src.attribution) src.attribution = state.config.basemap?.attribution || '© OpenStreetMap-Mitwirkende';
    for (const layer of out.layers) {
      const kind = kindOf(layer);
      layer.paint = layer.paint || {};
      if (kind === 'background') layer.paint['background-color'] = p.land;
      else if (layer.type === 'fill' && fill[kind]) {
        layer.paint['fill-color'] = fill[kind];
        delete layer.paint['fill-pattern'];
        if (kind === 'building') layer.paint['fill-outline-color'] = p.buildingEdge;
        if (kind === 'residential' || kind === 'industrial') layer.paint['fill-opacity'] = 0.7;
      } else if (layer.type === 'fill-extrusion' && kind === 'building') {
        layer.paint['fill-extrusion-color'] = p.building;
      } else if (layer.type === 'line' && line[kind]) {
        layer.paint['line-color'] = line[kind];
      } else if (layer.type === 'symbol') {
        layer.paint['text-color'] = kind === 'label-water' ? p.waterLine : kind === 'label-place' ? p.text : p.textMuted;
        layer.paint['text-halo-color'] = p.halo;
        layer.paint['text-halo-width'] = 1.4;
        // Icons (shops, bus stops …) clutter a map about the forest: only text stays.
        if (layer.layout?.['icon-image'] && !layer.layout?.['text-field']) layer.layout.visibility = 'none';
        else if (layer.layout) delete layer.layout['icon-image'];
      } else if (layer.type === 'hillshade') {
        layer.paint['hillshade-shadow-color'] = dark() ? '#000000' : '#5b6b52';
      }
    }
    return out;
  }

  /* ---------- Loading ---------- */

  function loadScript(src) {
    return new Promise((resolve, reject) => {
      const s = el('script', { src });
      s.onload = resolve;
      s.onerror = () => reject(new Error(src));
      document.head.append(s);
    });
  }

  let loading = null;
  async function loadGl() {
    if (gl || glFailed) return gl;
    loading = loading || (async () => {
      const url = state.config.basemap?.style;
      if (!url || !navigator.onLine) throw new Error('kein Vektorstil');
      // A quick check for WebGL: without it MapLibre cannot draw.
      const probe = document.createElement('canvas');
      if (!(probe.getContext('webgl2') || probe.getContext('webgl'))) throw new Error('kein WebGL');
      if (!window.maplibregl) {
        document.head.append(el('link', { rel: 'stylesheet', href: 'vendor/maplibre/maplibre-gl.css' }));
        await loadScript('vendor/maplibre/maplibre-gl.js');
      }
      if (!L.maplibreGL) await loadScript('vendor/maplibre-leaflet/leaflet-maplibre-gl.js');
      const res = await fetch(url);
      if (!res.ok) throw new Error(`Stil: HTTP ${res.status}`);
      const style = await res.json();
      if (!map.getPane('basemap')) {
        map.createPane('basemap');
        map.getPane('basemap').style.zIndex = 150; // under the tiles, overlays and markers
      }
      const layer = L.maplibreGL({ style: theme(style), pane: 'basemap', interactive: false });
      layer.rawStyle = style;
      return layer;
    })();
    try {
      gl = await loading;
    } catch (err) {
      glFailed = true;
      console.info('Grundkarte MyForrest nicht verfügbar, OpenStreetMap stattdessen:', err.message);
    }
    return gl;
  }

  /** Shows a base map; "myforrest" falls back to OpenStreetMap until (or unless) the vector map is ready. */
  let asked = 0;
  async function setBase(key) {
    if (!BASES[key]) key = 'myforrest';
    const my = ++asked;
    try { localStorage.setItem(STORE, key); } catch { /* private mode */ }
    const want = key === 'myforrest' ? ((await loadGl()) || osm) : BASES[key].layer;
    // A later choice (e.g. from a link) while the vector map was loading wins.
    if (my !== asked) return;
    const shown = current === 'myforrest' ? (gl || osm) : BASES[current].layer;
    if (shown !== want && map.hasLayer(shown)) map.removeLayer(shown);
    if (!map.hasLayer(want)) want.addTo(map);
    current = key;
    document.documentElement.classList.toggle('basemap-vector', want === gl);
    const sel = $('basemap-select');
    if (sel) sel.value = key;
  }

  // Dark mode follows the system: repaint the vector map.
  matchMedia('(prefers-color-scheme: dark)').addEventListener?.('change', () => {
    if (gl?.getMaplibreMap?.()) gl.getMaplibreMap().setStyle(theme(gl.rawStyle));
  });
  // Offline: OpenStreetMap, whose tiles the offline map keeps.
  addEventListener('offline', () => { if (current === 'myforrest' && gl && map.hasLayer(gl)) { map.removeLayer(gl); osm.addTo(map); } });
  addEventListener('online', () => { if (current === 'myforrest' && gl && !map.hasLayer(gl)) { map.removeLayer(osm); gl.addTo(map); } });

  /* ---------- Control ---------- */

  const Control = L.Control.extend({
    options: { position: 'bottomright' },
    onAdd() {
      const select = el('select', { id: 'basemap-select', 'aria-label': 'Grundkarte' },
        Object.entries(BASES).map(([k, b]) => el('option', { value: k, text: b.label })));
      select.addEventListener('change', () => setBase(select.value));
      const box = el('label', { class: 'basemap-control' }, [el('span', { class: 'sr-only', text: 'Grundkarte' }), select]);
      L.DomEvent.disableClickPropagation(box);
      return box;
    },
  });
  new Control().addTo(map);

  // Once the server said which style to use.
  let started = false;
  const wait = setInterval(() => {
    if (!state.config || !('basemap' in state.config)) return;
    clearInterval(wait);
    started = true;
    setBase(pref);
  }, 200);
  /** A base map asked for by a link (layers.js): now, or once the start above sets the base map. */
  const prefer = (key) => { if (started) setBase(key); else pref = key; };

  window.Basemap = { setBase, prefer, theme, kindOf, current: () => current };
})();
