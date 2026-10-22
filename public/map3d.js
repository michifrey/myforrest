'use strict';

/* =========================================================
   3D map: the spots on the terrain, seen at an angle. MapLibre (also used by
   vektorkarte.html) is loaded only when the view is opened. Elevation comes
   from the server (/api/terrain, Terrarium tiles, kept there), the picture
   from OpenStreetMap or the aerial photo of swisstopo; glacier outlines and
   the current route of "Touren & Aufträge" lie on the terrain. Buildings and
   trees of swisstopo come as 3D Tiles through deck.gl (loaded only when
   switched on), shifted from the ellipsoid down to the terrain's sea level.
   Uses the globals of app.js ($, el, api, state, map, pinKind, openSpot) and
   tours.js (Tours).
   ========================================================= */
(function map3d() {
  const COLORS = { ok: '#2f5d34', damage: '#c2611d', neo: '#8650c8' };
  const SWISS = [5.7, 45.7, 10.7, 47.95]; // where the aerial photo of swisstopo exists
  const STORE = 'myforrest-map3d';
  const prefs = (() => { try { return { base: 'osm', exaggeration: 1.5, tiles: [], ...JSON.parse(localStorage.getItem(STORE)) }; } catch { return { base: 'osm', exaggeration: 1.5, tiles: [] }; } })();
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

  let deckLib = null; // promise of the deck.gl bundle
  function loadDeck() {
    if (window.deck?.Tile3DLayer) return Promise.resolve(window.deck);
    deckLib = deckLib || new Promise((resolve, reject) => {
      const s = el('script', { src: 'vendor/deck/deck.min.js' });
      s.onload = () => resolve(window.deck);
      s.onerror = () => { deckLib = null; reject(new Error('3D-Bibliothek konnte nicht geladen werden (offline?)')); };
      document.head.append(s);
    });
    return deckLib;
  }

  /* ---------- Buildings and trees (3D Tiles of swisstopo) ---------- */

  /**
   * Shift of the tiles along the vertical at the middle of Switzerland, in Earth-centred coordinates:
   * the tiles stand on the WGS84 ellipsoid, the terrain on sea level (geoid ~50 m above it).
   */
  function heightShift(metres) {
    const lat = (46.8 * Math.PI) / 180; const lon = (8.2 * Math.PI) / 180;
    return [Math.cos(lat) * Math.cos(lon) * metres, Math.cos(lat) * Math.sin(lon) * metres, Math.sin(lat) * metres];
  }

  /** Puts the chosen 3D Tiles layers on the map (deck.gl interleaved with MapLibre), or takes them off. */
  async function setTiles(m, ids, status) {
    const cfg = state.config.tiles3d;
    const wanted = (cfg?.layers || []).filter((l) => ids.includes(l.id));
    if (m.getLayer('tiles3d-credit')) m.setLayoutProperty('tiles3d-credit', 'visibility', wanted.length ? 'visible' : 'none');
    if (!wanted.length) {
      if (view?.overlay) view.overlay.setProps({ layers: [] });
      return;
    }
    let deck;
    try {
      deck = await loadDeck();
    } catch (err) {
      status.textContent = err.message;
      status.hidden = false;
      return;
    }
    if (!view || view.map !== m) return;
    const shift = heightShift(cfg.height);
    const layers = wanted.map((l) => new deck.Tile3DLayer({
      id: `tiles3d-${l.id}`,
      data: l.url,
      pointSize: 2.5,
      // The tiles are as sharp as the screen needs; a bit coarser keeps phones fluid.
      loadOptions: { tileset: { maximumScreenSpaceError: 12, throttleRequests: true } },
      onTilesetLoad: (tileset) => {
        const matrix = tileset.modelMatrix.clone();
        [matrix[12], matrix[13], matrix[14]] = shift;
        tileset.modelMatrix = matrix;
      },
      onTileError: (tile, url, message) => console.warn('3D Tiles:', url, message),
    }));
    if (!view.overlay) {
      view.overlay = new deck.MapboxOverlay({ interleaved: true, layers });
      m.addControl(view.overlay);
    } else {
      view.overlay.setProps({ layers });
    }
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

  /** The view direction of the spots as a fan of 60° and 45 m on the ground, like the cones of the flat map. */
  function coneFeatures() {
    const R = 45;
    const features = [];
    for (const s of state.spots || []) {
      if (!Number.isFinite(s.heading)) continue;
      const ring = [[s.lon, s.lat]];
      for (let a = -30; a <= 30; a += 6) {
        const t = ((s.heading + a) * Math.PI) / 180;
        ring.push([s.lon + (Math.sin(t) * R) / (111320 * Math.cos((s.lat * Math.PI) / 180)), s.lat + (Math.cos(t) * R) / 111320]);
      }
      ring.push([s.lon, s.lat]);
      features.push({ type: 'Feature', geometry: { type: 'Polygon', coordinates: [ring] }, properties: { id: s.id } });
    }
    return { type: 'FeatureCollection', features };
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
        cones: { type: 'geojson', data: coneFeatures() },
        glaciers: { type: 'geojson', data: { type: 'FeatureCollection', features: [] } },
        // Carries the credit of the 3D Tiles (deck.gl layers have none in MapLibre); its layer is shown with them.
        tiles3dCredit: { type: 'geojson', data: { type: 'FeatureCollection', features: [] }, attribution: 'Gebäude und Bäume 3D © swisstopo' },
      },
      layers: [
        { id: 'osm', type: 'raster', source: 'osm', layout: { visibility: prefs.base === 'osm' ? 'visible' : 'none' } },
        { id: 'swissimage', type: 'raster', source: 'swissimage', layout: { visibility: prefs.base === 'luftbild' ? 'visible' : 'none' } },
        { id: 'hillshade', type: 'hillshade', source: 'hill', paint: { 'hillshade-exaggeration': 0.3, 'hillshade-shadow-color': '#2b3a2c' } },
        { id: 'tiles3d-credit', type: 'circle', source: 'tiles3dCredit', layout: { visibility: 'none' } },
        { id: 'glacier-fill', type: 'fill', source: 'glaciers', paint: { 'fill-color': '#9ad0ec', 'fill-opacity': 0.45 } },
        { id: 'glacier-line', type: 'line', source: 'glaciers', paint: { 'line-color': '#3d8fc0', 'line-width': 1.2 } },
        { id: 'cones', type: 'fill', source: 'cones', paint: { 'fill-color': '#c9a227', 'fill-opacity': 0.4 } },
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

  /* ---------- Flight along the route ---------- */

  const toRad = (d) => (d * Math.PI) / 180;
  const metres = (a, b) => Math.hypot(toRad(b.lon - a.lon) * Math.cos(toRad((a.lat + b.lat) / 2)), toRad(b.lat - a.lat)) * 6371000;
  const bearingOf = (a, b) => {
    const y = Math.sin(toRad(b.lon - a.lon)) * Math.cos(toRad(b.lat));
    const x = Math.cos(toRad(a.lat)) * Math.sin(toRad(b.lat)) - Math.sin(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.cos(toRad(b.lon - a.lon));
    return (Math.atan2(y, x) * 180) / Math.PI;
  };

  /**
   * Flies along the current route: the camera follows the line at walking-speed-like pace, looking ahead
   * (about 300 m), smoothed so it does not jerk at every bend. A second click, or touching the map, stops.
   */
  function fly() {
    if (!view?.map) return;
    if (view.flight) return stopFlight();
    const pts = (window.Tours?.points?.() || []).filter((p) => Number.isFinite(p.lat) && Number.isFinite(p.lon));
    if (pts.length < 2) return;
    const cum = [0];
    for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + metres(pts[i - 1], pts[i]));
    const total = cum.at(-1);
    if (!total) return;
    // 20 s for short routes, at most 90 s for long ones.
    const duration = Math.min(90000, Math.max(20000, total * 4));
    const at = (d) => {
      const dd = Math.max(0, Math.min(total, d));
      let i = 1;
      while (i < cum.length - 1 && cum[i] < dd) i++;
      const t = cum[i] === cum[i - 1] ? 0 : (dd - cum[i - 1]) / (cum[i] - cum[i - 1]);
      return { lat: pts[i - 1].lat + (pts[i].lat - pts[i - 1].lat) * t, lon: pts[i - 1].lon + (pts[i].lon - pts[i - 1].lon) * t };
    };
    const m = view.map;
    const start = performance.now();
    let bearing = bearingOf(at(0), at(300));
    const flight = { frame: 0 };
    const step = (now) => {
      if (view?.flight !== flight) return;
      const f = Math.min(1, (now - start) / duration);
      const d = f * total;
      const here = at(d);
      const target = bearingOf(here, at(d + 300));
      // Turn by the shorter way, a little per frame.
      bearing += ((((target - bearing) % 360) + 540) % 360 - 180) * 0.04;
      m.jumpTo({ center: [here.lon, here.lat], bearing, pitch: 68, zoom: 15.6 });
      if (f < 1) flight.frame = requestAnimationFrame(step);
      else stopFlight();
    };
    view.flight = flight;
    view.root.querySelector('.map3d-fly').textContent = 'Flug anhalten';
    m.once('mousedown', stopFlight);
    m.once('touchstart', stopFlight);
    flight.frame = requestAnimationFrame(step);
  }

  function stopFlight() {
    if (!view?.flight) return;
    cancelAnimationFrame(view.flight.frame);
    view.flight = null;
    const b = view.root.querySelector('.map3d-fly');
    if (b) b.textContent = 'Route abfliegen';
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

  /** Opens the 3D view where the flat map is, or at a spot (looking its way, with its popup). */
  async function open(options = {}) {
    if (view) return;
    const spot = options.spot || null;
    const exag = el('select', { id: 'map3d-exag', 'aria-label': 'Überhöhung' },
      [[1, 'Gelände 1×'], [1.5, 'Gelände 1,5×'], [2, 'Gelände 2×'], [3, 'Gelände 3×']].map(([v, t]) => el('option', { value: String(v), text: t })));
    exag.value = String(prefs.exaggeration);
    const base = el('select', { id: 'map3d-base', 'aria-label': 'Hintergrund' },
      [['osm', 'Karte (OSM)'], ['luftbild', 'Luftbild (CH)']].map(([v, t]) => el('option', { value: v, text: t })));
    base.value = prefs.base;
    // Buildings and trees: only where swisstopo has them, and on terrain without exaggeration (they would float).
    const tilesCfg = state.config.tiles3d?.layers || [];
    const tileBoxes = tilesCfg.map((l) => {
      const input = el('input', { type: 'checkbox', value: l.id });
      input.checked = (prefs.tiles || []).includes(l.id);
      return el('label', { class: 'map3d-tile' }, [input, ` ${l.title}`]);
    });
    const status = el('p', { class: 'map3d-status', role: 'status', text: '3D-Karte wird geladen …' });
    const container = el('div', { class: 'map3d-canvas' });
    const root = el('div', { id: 'map3d', class: 'map3d', role: 'dialog', 'aria-modal': 'true', 'aria-label': '3D-Karte' }, [
      container,
      el('div', { class: 'map3d-bar' }, [
        el('strong', { text: '3D-Karte' }),
        base, exag, ...tileBoxes,
        el('button', { type: 'button', class: 'btn secondary map3d-fly', hidden: '', text: 'Route abfliegen' }),
        el('span', { class: 'map3d-hint', text: 'Rechte Maustaste oder zwei Finger: kippen und drehen' }),
        el('button', { type: 'button', class: 'icon map3d-close', 'aria-label': 'Schliessen', text: '×' }),
      ]),
      status,
    ]);
    document.body.append(root);
    document.body.style.overflow = 'hidden';
    view = { root, map: null };
    root.querySelector('.map3d-close').addEventListener('click', close);
    const flyBtn = root.querySelector('.map3d-fly');
    flyBtn.hidden = (window.Tours?.points?.() || []).length < 2;
    flyBtn.addEventListener('click', fly);
    base.addEventListener('change', () => setBase(base.value));
    exag.addEventListener('change', () => {
      prefs.exaggeration = Number(exag.value);
      savePrefs();
      view?.map?.setTerrain({ source: 'dem', exaggeration: prefs.exaggeration });
      // Exaggerated terrain and real buildings do not fit: the buildings go off.
      if (prefs.exaggeration !== 1 && prefs.tiles.length) {
        prefs.tiles = [];
        savePrefs();
        for (const b of tileBoxes) b.querySelector('input').checked = false;
        if (view?.map) setTiles(view.map, [], status);
      }
    });
    for (const box of tileBoxes) {
      box.querySelector('input').addEventListener('change', () => {
        prefs.tiles = tileBoxes.filter((b) => b.querySelector('input').checked).map((b) => b.querySelector('input').value);
        if (prefs.tiles.length && prefs.exaggeration !== 1) {
          prefs.exaggeration = 1;
          exag.value = '1';
          view?.map?.setTerrain({ source: 'dem', exaggeration: 1 });
        }
        savePrefs();
        if (view?.map) setTiles(view.map, prefs.tiles, status);
      });
    }

    let maplibregl;
    try {
      maplibregl = await loadLib();
    } catch (err) {
      status.textContent = err.message;
      return;
    }
    if (!view || view.root !== root) return;
    const c = map.getCenter();
    const camera = spot
      // Behind the spot, looking where its photos look (north without a direction).
      ? { center: [spot.lon, spot.lat], zoom: 16, pitch: 70, bearing: Number.isFinite(spot.heading) ? spot.heading : 0 }
      : { center: [c.lng, c.lat], zoom: Math.max(3, map.getZoom() - 0.5), pitch: 62, bearing: -15 };
    let m;
    try {
      m = new maplibregl.Map({ container, style: style(), ...camera, maxPitch: 80, attributionControl: { compact: true } });
    } catch {
      status.textContent = 'Dieses Gerät kann keine 3D-Karte zeigen (WebGL fehlt).';
      return;
    }
    view.map = m;
    m.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), 'top-right');
    m.addControl(new maplibregl.ScaleControl({ unit: 'metric' }), 'bottom-left');
    m.on('load', () => {
      status.hidden = true;
      if (prefs.tiles.length) {
        if (prefs.exaggeration !== 1) m.setTerrain({ source: 'dem', exaggeration: (prefs.exaggeration = 1) });
        exag.value = String(prefs.exaggeration);
        setTiles(m, prefs.tiles, status);
      }
      loadGlaciers(m);
      if (spot) popupFor(maplibregl, m, spot.id, [spot.lon, spot.lat]);
    });
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

  /** Switches buildings and trees on or off from outside (screenshots, tests). */
  function showTiles(ids) {
    prefs.tiles = ids;
    savePrefs();
    for (const box of view?.root.querySelectorAll('.map3d-tile input') || []) box.checked = ids.includes(box.value);
    if (view?.map) {
      if (ids.length) {
        view.map.setTerrain({ source: 'dem', exaggeration: (prefs.exaggeration = 1) });
        view.root.querySelector('#map3d-exag').value = '1';
      }
      setTiles(view.map, ids, view.root.querySelector('.map3d-status'));
    }
  }

  function close() {
    if (!view) return;
    stopFlight();
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
  btn.addEventListener('click', () => open());
  // In a spot: its surroundings in 3D.
  $('spot-3d').addEventListener('click', () => {
    const s = state.spot && (state.spots || []).find((x) => x.id === state.spot.id);
    if (s) open({ spot: s });
  });
  // Shown once the server says it has terrain (api/config).
  const waitConfig = setInterval(() => {
    if (!('terrain' in state.config)) return;
    clearInterval(waitConfig);
    btn.hidden = !state.config.terrain;
    $('spot-3d').hidden = !state.config.terrain;
  }, 300);

  window.Map3D = { open, close, showSpot, fly, showTiles, map: null };
}());
