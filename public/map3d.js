'use strict';

/* =========================================================
   3D map: the spots on the terrain, seen at an angle. MapLibre (also used by
   vektorkarte.html) is loaded only when the view is opened. Elevation comes
   from the server (/api/terrain, Terrarium tiles, kept there), the picture
   from OpenStreetMap or the aerial photo of swisstopo; glacier outlines and
   the current route of "Touren & Aufträge" lie on the terrain.
   Uses the globals of app.js ($, el, api, state, map, pinKind, openSpot) and
   tours.js (Tours).
   ========================================================= */
(function map3d() {
  const COLORS = { ok: '#2f5d34', damage: '#c2611d', neo: '#8650c8' };
  const SWISS = [5.7, 45.7, 10.7, 47.95]; // where the aerial photo of swisstopo exists
  const STORE = 'myforrest-map3d';
  const prefs = (() => { try { return { base: 'osm', exaggeration: 1.5, ...JSON.parse(localStorage.getItem(STORE)) }; } catch { return { base: 'osm', exaggeration: 1.5 }; } })();
  const savePrefs = () => { try { localStorage.setItem(STORE, JSON.stringify(prefs)); } catch { /* private mode */ } };

  let lib = null; // promise of maplibregl
  let view = null; // the open overlay: { root, map }

  function loadLib() {
    if (window.maplibregl) return Promise.resolve(window.maplibregl);
    lib = lib || new Promise((resolve, reject) => {
      document.head.append(el('link', { rel: 'stylesheet', href: 'vendor/maplibre/maplibre-gl.css' }));
      const s = el('script', { src: 'vendor/maplibre/maplibre-gl.js' });
      s.onload = () => resolve(window.maplibregl);
      s.onerror = () => { lib = null; reject(new Error('Kartenbibliothek konnte nicht geladen werden (offline?)')); };
      document.head.append(s);
    });
    return lib;
  }

  const fmtDay = (iso) => (iso ? new Date(iso).toLocaleDateString('de-CH') : '');

  function spotFeatures() {
    return {
      type: 'FeatureCollection',
      features: (state.spots || []).map((s) => ({
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [s.lon, s.lat] },
        properties: { id: s.id, kind: pinKind(s), count: s.photoCount || 1, active: state.spot?.id === s.id },
      })),
    };
  }

  function routeFeature() {
    const pts = window.Tours?.points?.() || [];
    return {
      type: 'FeatureCollection',
      features: pts.length > 1 ? [{ type: 'Feature', geometry: { type: 'LineString', coordinates: pts.map((p) => [p.lon, p.lat]) }, properties: {} }] : [],
    };
  }

  function style() {
    const terrain = `${new URL('api/terrain/', document.baseURI).href}{z}/{x}/{y}.png`;
    const dem = { type: 'raster-dem', tiles: [terrain], encoding: 'terrarium', tileSize: 256, maxzoom: 13, attribution: 'Gelände: Terrain Tiles (Mapzen, SRTM u. a.)' };
    return {
      version: 8,
      sources: {
        osm: { type: 'raster', tiles: ['https://tile.openstreetmap.org/{z}/{x}/{y}.png'], tileSize: 256, maxzoom: 19, attribution: '© OpenStreetMap-Mitwirkende' },
        swissimage: {
          type: 'raster', tiles: ['https://wmts.geo.admin.ch/1.0.0/ch.swisstopo.swissimage/default/current/3857/{z}/{x}/{y}.jpeg'],
          tileSize: 256, maxzoom: 20, bounds: SWISS, attribution: 'Luftbild © swisstopo',
        },
        dem,
        hill: { ...dem },
        spots: { type: 'geojson', data: spotFeatures() },
        route: { type: 'geojson', data: routeFeature() },
        glaciers: { type: 'geojson', data: { type: 'FeatureCollection', features: [] } },
      },
      layers: [
        { id: 'osm', type: 'raster', source: 'osm', layout: { visibility: prefs.base === 'osm' ? 'visible' : 'none' } },
        { id: 'swissimage', type: 'raster', source: 'swissimage', layout: { visibility: prefs.base === 'luftbild' ? 'visible' : 'none' } },
        { id: 'hillshade', type: 'hillshade', source: 'hill', paint: { 'hillshade-exaggeration': 0.3, 'hillshade-shadow-color': '#2b3a2c' } },
        { id: 'glacier-fill', type: 'fill', source: 'glaciers', paint: { 'fill-color': '#9ad0ec', 'fill-opacity': 0.45 } },
        { id: 'glacier-line', type: 'line', source: 'glaciers', paint: { 'line-color': '#3d8fc0', 'line-width': 1.2 } },
        { id: 'route-casing', type: 'line', source: 'route', layout: { 'line-join': 'round', 'line-cap': 'round' }, paint: { 'line-color': '#ffffff', 'line-width': 7, 'line-opacity': 0.8 } },
        { id: 'route', type: 'line', source: 'route', layout: { 'line-join': 'round', 'line-cap': 'round' }, paint: { 'line-color': '#c9a227', 'line-width': 4 } },
        {
          id: 'spots', type: 'circle', source: 'spots',
          paint: {
            'circle-color': ['match', ['get', 'kind'], 'damage', COLORS.damage, 'neo', COLORS.neo, COLORS.ok],
            'circle-radius': ['interpolate', ['linear'], ['get', 'count'], 1, 7, 8, 10, 40, 14],
            'circle-stroke-color': ['case', ['get', 'active'], '#c9a227', '#ffffff'],
            'circle-stroke-width': ['case', ['get', 'active'], 3.5, 2],
            'circle-pitch-alignment': 'viewport',
          },
        },
      ],
      terrain: { source: 'dem', exaggeration: prefs.exaggeration },
      sky: { 'sky-color': '#bcd8ec', 'horizon-color': '#eef3ea', 'fog-color': '#eef3ea', 'sky-horizon-blend': 0.6, 'horizon-fog-blend': 0.6, 'fog-ground-blend': 0.85 },
    };
  }

  async function loadGlaciers(m) {
    if (!state.config.glaciers || m.getZoom() < 9) return;
    const b = m.getBounds();
    const bbox = [b.getWest(), b.getSouth(), b.getEast(), b.getNorth()].map((v) => v.toFixed(4)).join(',');
    const fc = await api(`/api/glaciers?bbox=${bbox}`).catch(() => null);
    if (!fc || view?.map !== m) return;
    // The latest outline of each glacier: today's ice, not the old extents on top of each other.
    const latest = new Map();
    for (const f of fc.features) {
      const key = f.properties.name || f.properties.id || JSON.stringify(f.geometry).slice(0, 40);
      if (!latest.has(key) || (f.properties.year ?? 0) > (latest.get(key).properties.year ?? 0)) latest.set(key, f);
    }
    m.getSource('glaciers')?.setData({ type: 'FeatureCollection', features: [...latest.values()] });
  }

  function popupFor(maplibregl, m, id, lngLat) {
    const s = (state.spots || []).find((x) => x.id === id);
    if (!s) return;
    const dates = [fmtDay(s.firstTaken), fmtDay(s.lastTaken)].filter(Boolean);
    const box = el('div', { class: 'map3d-popup' }, [
      s.latestThumbUrl ? el('img', { src: s.latestThumbUrl, alt: '' }) : null,
      el('strong', { text: `Spot ${s.id}` }),
      el('span', { text: `${s.photoCount} Foto${s.photoCount === 1 ? '' : 's'}${dates.length ? ` · ${[...new Set(dates)].join(' – ')}` : ''}` }),
      Number.isFinite(s.elevation) ? el('span', { text: `${Math.round(s.elevation)} m ü. M.` }) : null,
      el('button', { type: 'button', class: 'btn primary', text: 'Spot öffnen' }),
    ].filter(Boolean));
    box.querySelector('button').addEventListener('click', () => { close(); openSpot(s.id); });
    new maplibregl.Popup({ offset: 14, maxWidth: '240px' }).setLngLat(lngLat).setDOMContent(box).addTo(m);
  }

  /** Shows a spot: the view turns to it, and its popup opens. */
  function showSpot(id) {
    const s = (state.spots || []).find((x) => x.id === id);
    if (!view?.map || !s || !window.maplibregl) return;
    view.map.easeTo({ center: [s.lon, s.lat], duration: 600 });
    view.map.once('moveend', () => popupFor(window.maplibregl, view.map, id, [s.lon, s.lat]));
  }

  function setBase(base) {
    prefs.base = base;
    savePrefs();
    if (!view) return;
    view.map.setLayoutProperty('osm', 'visibility', base === 'osm' ? 'visible' : 'none');
    view.map.setLayoutProperty('swissimage', 'visibility', base === 'luftbild' ? 'visible' : 'none');
  }

  async function open() {
    if (view) return;
    const exag = el('select', { id: 'map3d-exag', 'aria-label': 'Überhöhung' },
      [[1, 'Gelände 1×'], [1.5, 'Gelände 1,5×'], [2, 'Gelände 2×'], [3, 'Gelände 3×']].map(([v, t]) => el('option', { value: String(v), text: t })));
    exag.value = String(prefs.exaggeration);
    const base = el('select', { id: 'map3d-base', 'aria-label': 'Hintergrund' },
      [['osm', 'Karte (OSM)'], ['luftbild', 'Luftbild (CH)']].map(([v, t]) => el('option', { value: v, text: t })));
    base.value = prefs.base;
    const status = el('p', { class: 'map3d-status', role: 'status', text: '3D-Karte wird geladen …' });
    const container = el('div', { class: 'map3d-canvas' });
    const root = el('div', { id: 'map3d', class: 'map3d', role: 'dialog', 'aria-modal': 'true', 'aria-label': '3D-Karte' }, [
      container,
      el('div', { class: 'map3d-bar' }, [
        el('strong', { text: '3D-Karte' }),
        base, exag,
        el('span', { class: 'map3d-hint', text: 'Rechte Maustaste oder zwei Finger: kippen und drehen' }),
        el('button', { type: 'button', class: 'icon map3d-close', 'aria-label': 'Schliessen', text: '×' }),
      ]),
      status,
    ]);
    document.body.append(root);
    document.body.style.overflow = 'hidden';
    view = { root, map: null };
    root.querySelector('.map3d-close').addEventListener('click', close);
    base.addEventListener('change', () => setBase(base.value));
    exag.addEventListener('change', () => {
      prefs.exaggeration = Number(exag.value);
      savePrefs();
      view?.map?.setTerrain({ source: 'dem', exaggeration: prefs.exaggeration });
    });

    let maplibregl;
    try {
      maplibregl = await loadLib();
    } catch (err) {
      status.textContent = err.message;
      return;
    }
    if (!view || view.root !== root) return;
    const c = map.getCenter();
    let m;
    try {
      m = new maplibregl.Map({
        container, style: style(), center: [c.lng, c.lat],
        zoom: Math.max(3, map.getZoom() - 0.5), pitch: 62, bearing: -15, maxPitch: 80, attributionControl: { compact: true },
      });
    } catch {
      status.textContent = 'Dieses Gerät kann keine 3D-Karte zeigen (WebGL fehlt).';
      return;
    }
    view.map = m;
    m.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), 'top-right');
    m.addControl(new maplibregl.ScaleControl({ unit: 'metric' }), 'bottom-left');
    m.on('load', () => { status.hidden = true; loadGlaciers(m); });
    m.on('moveend', () => loadGlaciers(m));
    m.on('error', (e) => {
      console.warn('3D-Karte:', e?.error?.message || e);
      if (e?.sourceId === 'dem' || e?.sourceId === 'hill') status.textContent = 'Geländedaten nicht erreichbar.';
    });
    m.on('click', 'spots', (e) => popupFor(maplibregl, m, e.features[0].properties.id, e.lngLat));
    m.on('mouseenter', 'spots', () => { m.getCanvas().style.cursor = 'pointer'; });
    m.on('mouseleave', 'spots', () => { m.getCanvas().style.cursor = ''; });
    window.Map3D.map = m;
  }

  function close() {
    if (!view) return;
    const m = view.map;
    if (m) {
      // Back on the flat map where the 3D view was left.
      const c = m.getCenter();
      map.setView([c.lat, c.lng], Math.min(18, Math.round(m.getZoom() + 0.5)));
      m.remove();
    }
    view.root.remove();
    view = null;
    window.Map3D.map = null;
    document.body.style.overflow = '';
  }

  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && view) close(); });
  const btn = $('map3d-toggle');
  btn.addEventListener('click', open);
  // Shown once the server says it has terrain (api/config).
  const waitConfig = setInterval(() => {
    if (!('terrain' in state.config)) return;
    clearInterval(waitConfig);
    btn.hidden = !state.config.terrain;
  }, 300);

  window.Map3D = { open, close, showSpot, map: null };
}());
