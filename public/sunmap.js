'use strict';

/*
 * "Sonne & Wetter" map mode: sun path, sun position and tree shadow around
 * the selected spot (or the map centre) for any date and time, clear-sky
 * irradiance on flat ground and on the spot's slope, and – for past days
 * and the coming ~16 days – measured or forecast radiation and rain.
 * The terrain horizon (from the elevation model) blocks the sun behind
 * hills and mountains and narrows the sky for diffuse light.
 * "Kühle Abschnitte aus Touren" lays the map of cool stretches over it:
 * cells of 100 m from the temperatures people share with their tours
 * (src/coolmap.js), blue where it is cooler than the rest of the same tours.
 * By default only tours of the chosen season (summer/winter) and time of day
 * (sun up or down) count; with the model's air temperature of that hour the
 * tooltip estimates the temperature in the cell.
 * "Licht und Schatten auf der Karte" darkens the ground the terrain shades
 * at the chosen time (elevation tiles, shade.js), tints slopes in a steep sun
 * and shows night and twilight; a DWD map (radar, warnings) can go on top.
 * Relies on globals from app.js (map, state, api, el, $), sun.js (Sun) and
 * shade.js (Shade).
 */
(function sunMode() {
  const TREE_HEIGHT = 25; // m, for the shadow
  const RING_PX = 110; // radius of the sun-path diagram on screen
  const sunLayer = L.layerGroup();
  const rainLayer = L.layerGroup();
  const coolLayer = L.layerGroup();
  const COOL_MIN_ZOOM = 13;
  const sm = {
    open: false,
    date: null,
    minute: 720,
    day: null, // Sun.day(...) for place and date
    weather: null, // /api/weather/day
    horizon: null, // /api/horizon for the place, null while loading or unavailable
    horizonError: null,
    playing: null,
    loadToken: 0,
  };

  const pad = (n) => String(n).padStart(2, '0');
  const isoLocal = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const dayStart = (date) => new Date(`${date}T00:00:00`).getTime();
  const clock = (t) => new Date(t).toLocaleTimeString('de-CH', { hour: '2-digit', minute: '2-digit' });
  const fmtNum = (v, d = 0) => v.toLocaleString('de-CH', { minimumFractionDigits: d, maximumFractionDigits: d });

  /** The place the sun is computed for: open spot (with its terrain) or map centre. */
  function place() {
    if (state.spot) {
      return {
        lat: state.spot.lat,
        lon: state.spot.lon,
        label: `Spot ${state.spot.id}`,
        elevation: state.spot.elevation,
        slope: state.spot.slope,
        aspect: state.spot.aspect,
        exposition: state.spot.exposition,
      };
    }
    const c = map.getCenter();
    return { lat: c.lat, lon: c.lng, label: 'Kartenmitte', elevation: null, slope: null, aspect: null, exposition: null };
  }

  function metresPerPixel(lat) {
    return (40075016.686 * Math.cos((lat * Math.PI) / 180)) / 2 ** (map.getZoom() + 8);
  }

  /* ---------- Terrain horizon ---------- */

  const horizonCache = new Map();
  /** Horizon of a place; the map centre is rounded to ~100 m so panning reuses it. */
  async function fetchHorizon(p) {
    const key = `${p.lat.toFixed(p.label === 'Kartenmitte' ? 3 : 4)},${p.lon.toFixed(p.label === 'Kartenmitte' ? 3 : 4)}`;
    if (!horizonCache.has(key)) {
      const [lat, lon] = key.split(',');
      horizonCache.set(key, api(`/api/horizon?lat=${lat}&lon=${lon}`).catch((err) => ({ angles: null, error: err.message })));
    }
    const h = await horizonCache.get(key);
    if (!h.angles) horizonCache.delete(key); // try again next time
    return h;
  }

  const behindAt = (sun) => sun.altitude > 0 && sun.altitude + 0.27 <= Math.max(0, Sun.horizonAt(sm.horizon, sun.azimuth));

  /** Highest ridge of the horizon: angle, direction, distance. */
  function ridge() {
    const h = sm.horizon;
    if (!h?.angles) return null;
    let k = 0;
    h.angles.forEach((a, i) => { if (a > h.angles[k]) k = i; });
    return { angle: h.angles[k], azimuth: k * h.step, distance: h.distances?.[k] ?? null };
  }

  /* ---------- Map overlay ---------- */

  function drawMap() {
    sunLayer.clearLayers();
    if (!sm.open || !sm.day) return;
    const p = place();
    const R = RING_PX * metresPerPixel(p.lat);
    const at = (az, dist) => Sun.destination(p.lat, p.lon, az, dist);
    const css = getComputedStyle(document.documentElement);
    const gold = css.getPropertyValue('--sun').trim() || '#a8780c';

    const terrainColour = css.getPropertyValue('--terrain').trim() || '#6e5a3c';

    // Horizon ring and the sun's path projected onto it (zenith in the centre).
    L.circle([p.lat, p.lon], { radius: R, color: gold, weight: 1, dashArray: '3 5', fill: true, fillOpacity: 0.05, interactive: false }).addTo(sunLayer);
    if (sm.horizon?.angles) {
      // Terrain silhouette: everything between the horizon ring and the terrain line is hidden sky.
      const outer = []; const inner = [];
      for (let az = 0; az < 360; az += 5) {
        outer.push(at(az, R));
        inner.push(at(az, R * (1 - Math.max(0, Sun.horizonAt(sm.horizon, az)) / 90)));
      }
      L.polygon([outer, inner], { stroke: false, fillColor: terrainColour, fillOpacity: 0.32, interactive: false }).addTo(sunLayer);
      L.polygon(inner, { color: terrainColour, weight: 1.5, fill: false, interactive: false }).addTo(sunLayer);
    }
    // Sun path: solid where the sun shines on the place, dashed where the terrain hides it.
    let run = []; let runBehind = null;
    const flush = () => {
      if (run.length > 1) {
        L.polyline(run, runBehind
          ? { color: gold, weight: 2, opacity: 0.55, dashArray: '2 6', interactive: false }
          : { color: gold, weight: 2.5, opacity: 0.85, interactive: false }).addTo(sunLayer);
      }
    };
    for (const s of sm.day.samples) {
      if (s.altitude <= 0) { flush(); run = []; runBehind = null; continue; }
      const pt = at(s.azimuth, R * (1 - s.altitude / 90));
      if (runBehind !== null && s.behind !== runBehind) { run.push(pt); flush(); run = [run[run.length - 1]]; }
      runBehind = s.behind;
      run.push(pt);
    }
    flush();

    const terrain = Boolean(sm.horizon?.angles);
    const edges = terrain
      ? [[sm.day.terrainRise, 'Sonne ab'], [sm.day.terrainSet, 'Sonne bis']]
      : [[sm.day.sunrise, 'Aufgang'], [sm.day.sunset, 'Untergang']];
    for (const [t, name] of edges) {
      if (t === null) continue;
      const az = Sun.position(t, p.lat, p.lon).azimuth;
      L.polyline([[p.lat, p.lon], at(az, R)], { color: '#e07b28', weight: 2, dashArray: '6 5', interactive: false }).addTo(sunLayer);
      L.marker(at(az, R * 1.12), {
        icon: L.divIcon({ className: '', html: `<span class="map-label">${name} ${clock(t)}</span>`, iconSize: null, iconAnchor: [40, 10] }),
        interactive: false,
      }).addTo(sunLayer);
    }

    const t = dayStart(sm.date) + sm.minute * 60000;
    const sun = Sun.position(t, p.lat, p.lon);
    if (sun.altitude > 0) {
      const behind = behindAt(sun);
      const pos = at(sun.azimuth, R * (1 - sun.altitude / 90));
      L.polyline([[p.lat, p.lon], pos], { color: gold, weight: 2, opacity: behind ? 0.3 : 0.6, interactive: false }).addTo(sunLayer);
      L.marker(pos, {
        icon: L.divIcon({ className: '', html: `<div class="sun-marker${behind ? ' behind' : ''}"></div>`, iconSize: [22, 22], iconAnchor: [11, 11] }),
        interactive: false,
        zIndexOffset: 1000, // above pins and rain badges
      }).addTo(sunLayer);
    }
    if (sun.altitude > 0 && !behindAt(sun)) {
      // Shadow of a tree at the place, in real metres on the map.
      const shadow = Math.min(TREE_HEIGHT / Math.tan((sun.altitude * Math.PI) / 180), 2000);
      L.polyline([[p.lat, p.lon], at((sun.azimuth + 180) % 360, shadow)], { color: '#1b2a1f', weight: 5, opacity: 0.55, lineCap: 'round', interactive: false }).addTo(sunLayer);
    }
    L.circleMarker([p.lat, p.lon], { radius: 4, color: '#fff', weight: 2, fillColor: gold, fillOpacity: 1, interactive: false }).addTo(sunLayer);
  }

  /** Rain of the chosen day at every spot. */
  async function drawRain() {
    rainLayer.clearLayers();
    if (!sm.open || !sm.date) return;
    const token = sm.loadToken;
    let data;
    try {
      data = await api(`/api/weather/day/spots?date=${sm.date}`);
    } catch {
      return;
    }
    if (token !== sm.loadToken || !sm.open) return;
    const bySpot = new Map(data.spots.map((s) => [s.spotId, s.precip]));
    for (const s of state.spots) {
      const v = bySpot.get(s.id);
      if (v === null || v === undefined) continue;
      const drop = '<svg viewBox="0 0 10 10" aria-hidden="true"><path d="M5 0C5 0 1 4.6 1 6.6a4 4 0 0 0 8 0C9 4.6 5 0 5 0z"/></svg>';
      L.marker([s.lat, s.lon], {
        icon: L.divIcon({
          className: '',
          html: `<span class="rain-badge${v < 0.1 ? ' dry' : ''}" title="Niederschlag am ${sm.date}">${drop}${fmtNum(v, v < 10 ? 1 : 0)} mm</span>`,
          iconSize: null,
          iconAnchor: [-14, 4],
        }),
        interactive: false,
        zIndexOffset: 500,
      }).addTo(rainLayer);
    }
  }

  /* ---------- Cool stretches from shared tour temperatures ---------- */

  let coolToken = 0;
  const coolOn = () => sm.open && $('cool-toggle').checked;
  /** -2 °C (blue) … 0 (pale) … +2 °C (red), like the temperature along a tour. */
  function coolColor(delta) {
    const stops = [[43, 108, 176], [239, 227, 161], [192, 57, 43]];
    const x = (Math.max(-2, Math.min(2, delta)) + 2) / 2; // 0..2
    const i = Math.min(1, Math.floor(x));
    return `rgb(${stops[i].map((v, j) => Math.round(v + (stops[i + 1][j] - v) * (x - i))).join(',')})`;
  }
  /** Season and time of day of the chosen date and minute, as the server classes tours. */
  function coolMoment() {
    const t = dayStart(sm.date || isoLocal(new Date())) + sm.minute * 60000;
    const p = place();
    const month = new Date(t).getMonth() + 1;
    return {
      t,
      season: month >= 4 && month <= 9 ? 'sommer' : 'winter',
      daytime: Sun.position(t, p.lat, p.lon).altitude > 0 ? 'tag' : 'nacht',
    };
  }
  let coolKey = '';
  async function drawCool({ force = false } = {}) {
    const status = $('cool-status');
    $('cool-match').hidden = !coolOn();
    if (!coolOn()) { coolLayer.clearLayers(); status.hidden = true; coolKey = ''; return; }
    status.hidden = false;
    const moment = coolMoment();
    const matching = $('cool-match').value === 'zeit';
    const filter = matching ? `&season=${moment.season}&daytime=${moment.daytime}` : '';
    const key = `${map.getBounds().toBBoxString()}${filter}:${map.getZoom()}`;
    if (!force && key === coolKey) return redrawCoolTooltips(moment);
    coolKey = key;
    const token = ++coolToken;
    if (map.getZoom() < COOL_MIN_ZOOM) {
      coolLayer.clearLayers();
      status.textContent = 'Zum Anzeigen näher heranzoomen.';
      return;
    }
    const b = map.getBounds();
    let data;
    try {
      data = await api(`/api/cool-cells?bbox=${[b.getWest(), b.getSouth(), b.getEast(), b.getNorth()].map((v) => v.toFixed(5)).join(',')}${filter}`);
    } catch (err) {
      if (token === coolToken) status.textContent = err.message;
      return;
    }
    if (token !== coolToken || !coolOn()) return;
    coolLayer.clearLayers();
    const half = data.cellM / 2;
    for (const c of data.cells) {
      const dLat = half / 111320;
      const dLon = half / (111320 * Math.cos((c.lat * Math.PI) / 180));
      const cell = L.rectangle([[c.lat - dLat, c.lon - dLon], [c.lat + dLat, c.lon + dLon]], {
        stroke: false, fillColor: coolColor(c.delta), fillOpacity: 0.6, className: 'cool-cell',
      });
      cell.coolData = c;
      cell.bindTooltip('', { sticky: true }).addTo(coolLayer);
    }
    redrawCoolTooltips(moment);
    const which = matching
      ? `nur Touren im ${moment.season === 'sommer' ? 'Sommerhalbjahr' : 'Winterhalbjahr'} ${moment.daytime === 'tag' ? 'bei Tag' : 'bei Nacht'} (wie die gewählte Zeit)`
      : 'alle Jahres- und Tageszeiten';
    status.replaceChildren(
      el('span', { class: 'cool-ramp', 'aria-hidden': 'true' }),
      ` kühler ↔ wärmer als der Rest derselben Touren (±2 °C), ${which}. ${data.cells.length ? `${data.cells.length} Zellen` : 'Hier noch keine Zellen'}`
        + ` (${data.cellM} m, je ab ${data.minTours} Touren von ${data.minPeople} Personen, die ihre Temperatur teilen).`,
    );
  }
  /** Tooltips: the deviation and, with the model's air temperature of the chosen hour, an estimate for the cell. */
  function redrawCoolTooltips(moment) {
    const air = weatherAt(moment.t)?.temp;
    coolLayer.eachLayer((cell) => {
      const c = cell.coolData;
      if (!c) return;
      const dev = `${fmtNum(Math.abs(c.delta), 1)} °C ${c.delta < 0 ? 'kühler' : 'wärmer'} als der Rest derselben Touren · ${c.tours} Touren`;
      // Two lines; all parts are numbers and fixed words (no user text).
      cell.setTooltipContent(Number.isFinite(air)
        ? `<b>≈ ${fmtNum(air + c.delta, 1)} °C</b> um ${clock(moment.t)} (Luft laut Wettermodell ${fmtNum(air, 1)} °C)<br>${dev}`
        : dev);
    });
  }
  $('cool-toggle').addEventListener('change', () => {
    try { localStorage.setItem('myforrest.cool', $('cool-toggle').checked ? '1' : ''); } catch { /* private mode */ }
    drawCool({ force: true });
  });
  $('cool-match').addEventListener('change', () => drawCool({ force: true }));
  try { $('cool-toggle').checked = localStorage.getItem('myforrest.cool') === '1'; } catch { /* private mode */ }
  map.on('moveend', () => coolOn() && drawCool());

  /* ---------- Light and shadow over the whole map ---------- */

  // Terrarium elevation tiles (AWS open data; in Europe EU-DEM, ~25 m), loaded straight from S3 (CORS open).
  const DEM_TILES = 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium';
  const SHADE_MIN_ZOOM = 9; // terrain shadows from here on; night and twilight at every zoom
  map.createPane('sunshade').style.zIndex = 240; // above the base map, below pins and lines
  map.createPane('dwd').style.zIndex = 250;
  let shadeOverlay = null;
  let shadeToken = 0;
  let shadeUrl = null; // object URL of the picture shown
  let shownToken = 0; // token of the picture shown
  let shadeFrame = 0;
  let dem = null; // fine grid of the view ({ z, tx0, ty0, gw, gh, elev }) with `far`, the coarse surroundings
  const demTiles = new Map();
  const shadeOn = () => sm.open && $('shade-toggle').checked;

  /** Elevations of one Terrarium tile (256×256, row-major), or null when it cannot be loaded. */
  function demTile(z, x, y) {
    const key = `${z}/${x}/${y}`;
    if (!demTiles.has(key)) {
      if (demTiles.size > 400) demTiles.delete(demTiles.keys().next().value);
      demTiles.set(key, new Promise((resolve) => {
        const img = new Image();
        img.crossOrigin = 'anonymous';
        img.onload = () => {
          const c = document.createElement('canvas');
          c.width = 256; c.height = 256;
          const ctx = c.getContext('2d', { willReadFrequently: true });
          ctx.drawImage(img, 0, 0);
          const px = ctx.getImageData(0, 0, 256, 256).data;
          const out = new Float32Array(65536);
          for (let i = 0; i < 65536; i++) out[i] = Shade.terrarium(px[i * 4], px[i * 4 + 1], px[i * 4 + 2]);
          resolve(out);
        };
        img.onerror = () => { demTiles.delete(key); resolve(null); };
        img.src = `${DEM_TILES}/${key}.png`;
      }));
    }
    return demTiles.get(key);
  }

  /** Elevations at DEM zoom `z` for the view plus `margin` tiles all round: `{ key, z, tx0, ty0, gw, gh, elev, missing, total }`. */
  async function loadGrid(z, margin) {
    const zoom = map.getZoom();
    const s = 2 ** (z - zoom);
    const b = map.getPixelBounds();
    const n = 2 ** z;
    const tx0 = Math.floor((b.min.x * s) / 256) - margin; const tx1 = Math.floor((b.max.x * s) / 256) + margin;
    const ty0 = Math.max(0, Math.floor((b.min.y * s) / 256) - margin); const ty1 = Math.min(n - 1, Math.floor((b.max.y * s) / 256) + margin);
    const key = `${z}/${tx0}/${ty0}/${tx1}/${ty1}`;
    const cols = tx1 - tx0 + 1; const rows = ty1 - ty0 + 1;
    const tiles = await Promise.all(Array.from({ length: cols * rows }, (_, k) => demTile(z, (((tx0 + (k % cols)) % n) + n) % n, ty0 + Math.floor(k / cols))));
    const gw = cols * 256; const gh = rows * 256;
    const elev = new Float32Array(gw * gh);
    let missing = 0;
    tiles.forEach((tile, k) => {
      const ox = (k % cols) * 256; const oy = Math.floor(k / cols) * 256;
      if (!tile) missing++;
      for (let y = 0; y < 256; y++) {
        if (tile) elev.set(tile.subarray(y * 256, (y + 1) * 256), (oy + y) * gw + ox);
        else elev.fill(-500, (oy + y) * gw + ox, (oy + y) * gw + ox + 256); // no data: low, casts no shadow
      }
    });
    return { key, z, tx0, ty0, gw, gh, elev, missing, total: tiles.length };
  }

  /**
   * Elevations for the shading: the view at DEM zoom map zoom − 2 (≤ 13) with
   * one tile of margin, and the wider surroundings 4× coarser (one tile of
   * margin there reaches ~13 km at map zoom 15, ~50 km at 13), so distant ridges and
   * mountains cast their long shadows when the sun is low.
   */
  async function loadDem() {
    const z = Math.min(13, Math.round(map.getZoom()) - 2);
    const zc = Math.max(3, z - 2);
    const key = `${map.getPixelBounds().min}:${map.getZoom()}`;
    if (dem?.key === `dem:${key}`) return dem;
    const [fine, coarse] = await Promise.all([loadGrid(z, 1), loadGrid(zc, 1)]);
    const scale = 2 ** (z - zc);
    dem = {
      ...fine,
      key: `dem:${key}`,
      far: { elev: coarse.elev, gw: coarse.gw, gh: coarse.gh, scale, ox: (fine.tx0 * 256) / scale - coarse.tx0 * 256, oy: (fine.ty0 * 256) / scale - coarse.ty0 * 256 },
      missing: fine.missing + coarse.missing,
      total: fine.total + coarse.total,
    };
    dem.shared = { elev: dem.elev, gw: dem.gw, gh: dem.gh, far: dem.far };
    return dem;
  }

  /*
   * Trees and buildings (from map zoom 16): heights above ground from /api/surface (src/surface.js), in
   * Switzerland from swisstopo (trees and buildings), elsewhere Meta's canopy heights (trees only).
   */
  const SURFACE_MIN_ZOOM = 16;
  const SURFACE_REACH = 300; // m around the view, for the shadows of trees and houses just outside
  const surfaceTiles = new Map();
  let surface = null; // { key, z, gx0, gy0, gw, gh, obj, top, missing, total } or a pending { key, pending }

  /** `{ heights, source }` of one surface tile (256×256), null where there is no data, undefined when it failed. */
  function surfaceTile(z, x, y) {
    const key = `${z}/${x}/${y}`;
    if (!surfaceTiles.has(key)) {
      if (surfaceTiles.size > 300) surfaceTiles.delete(surfaceTiles.keys().next().value);
      surfaceTiles.set(key, (async () => {
        const res = await fetch(`api/surface/${key}.png`);
        if (res.status === 204) return null;
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const bmp = await createImageBitmap(await res.blob());
        const c = document.createElement('canvas');
        c.width = 256; c.height = 256;
        const ctx = c.getContext('2d', { willReadFrequently: true });
        ctx.drawImage(bmp, 0, 0);
        const px = ctx.getImageData(0, 0, 256, 256).data;
        const out = new Float32Array(65536);
        for (let i = 0; i < 65536; i++) out[i] = Shade.terrarium(px[i * 4], px[i * 4 + 1], px[i * 4 + 2]);
        return { heights: out, source: res.headers.get('X-Surface-Source') || '' };
      })().catch(() => { surfaceTiles.delete(key); return undefined; }));
    }
    return surfaceTiles.get(key);
  }

  /**
   * Surface heights (terrain + trees and buildings) for the view and
   * SURFACE_REACH around it at zoom map zoom − 1, built on the elevation grid
   * `grid`. Returns the finished grid, or null while it is still loading (a
   * redraw follows) or when there is none.
   */
  function surfaceFor(grid) {
    const zoom = map.getZoom();
    const z = Math.min(17, Math.round(zoom) - 1);
    const s = 2 ** (z - zoom);
    const b = map.getPixelBounds();
    const pad = Math.ceil(SURFACE_REACH / Shade.metresPerPixel(map.getCenter().lat, z));
    const gx0 = Math.floor(b.min.x * s) - pad; const gy0 = Math.floor(b.min.y * s) - pad;
    const gx1 = Math.ceil(b.max.x * s) + pad; const gy1 = Math.ceil(b.max.y * s) + pad;
    const key = `${z}/${gx0}/${gy0}/${grid.key}`;
    if (surface?.key === key) return surface.pending ? null : surface;
    const tx0 = Math.floor(gx0 / 256); const tx1 = Math.floor((gx1 - 1) / 256);
    const ty0 = Math.floor(gy0 / 256); const ty1 = Math.floor((gy1 - 1) / 256);
    const list = [];
    for (let ty = ty0; ty <= ty1; ty++) for (let tx = tx0; tx <= tx1; tx++) list.push([tx, ty]);
    surface = { key, pending: true };
    Promise.all(list.map(([tx, ty]) => surfaceTile(z, tx, ty))).then((tiles) => {
      if (surface?.key !== key) return;
      const gw = gx1 - gx0; const gh = gy1 - gy0;
      const obj = new Float32Array(gw * gh);
      let found = 0; let missing = 0; let objectTop = 0;
      const sources = new Set();
      tiles.forEach((t, k) => {
        if (t === undefined) missing++;
        if (!t) return;
        found++;
        t.source.split('+').forEach((v) => v && sources.add(v));
        const tile = t.heights;
        const [tx, ty] = list[k];
        for (let y = Math.max(0, ty * 256 - gy0); y < Math.min(gh, (ty + 1) * 256 - gy0); y++) {
          for (let x = Math.max(0, tx * 256 - gx0); x < Math.min(gw, (tx + 1) * 256 - gx0); x++) {
            const v = tile[(y + gy0 - ty * 256) * 256 + (x + gx0 - tx * 256)];
            obj[y * gw + x] = v;
            if (v > objectTop) objectTop = v;
          }
        }
      });
      if (!found) { surface = { key, none: true, missing, total: tiles.length }; scheduleShade(); return; }
      // Terrain from the elevation grid (bilinear) plus the objects on it.
      const f = 2 ** (grid.z - z);
      const top = new Float32Array(gw * gh);
      for (let y = 0; y < gh; y++) {
        const dy = (gy0 + y + 0.5) * f - grid.ty0 * 256 + 0.5;
        for (let x = 0; x < gw; x++) {
          const dx = (gx0 + x + 0.5) * f - grid.tx0 * 256 + 0.5;
          top[y * gw + x] = Shade.bilinear(grid.elev, grid.gw, grid.gh, dx, dy) + obj[y * gw + x];
        }
      }
      surface = { key, z, gx0, gy0, gw, gh, top, objectTop, sources, missing, total: tiles.length, shared: { top, gw, gh } };
      scheduleShade();
    });
    return null;
  }

  /** Sun altitude across a w×h grid, computed every `step` cells and interpolated in between. */
  function altitudeGrid(t, w, h, step, latLngAt) {
    const cw = Math.ceil(w / step) + 1; const ch = Math.ceil(h / step) + 1;
    const lat = new Float32Array(cw * ch);
    for (let j = 0; j < ch; j++) {
      for (let i = 0; i < cw; i++) {
        const ll = latLngAt(i * step, j * step);
        lat[j * cw + i] = Sun.position(t, ll.lat, ll.lng).altitude;
      }
    }
    return (x, y) => {
      const fx = x / step; const fy = y / step;
      const i = Math.min(cw - 2, Math.floor(fx)); const j = Math.min(ch - 2, Math.floor(fy));
      const u = fx - i; const v = fy - j;
      const a = lat[j * cw + i]; const b = lat[j * cw + i + 1]; const c = lat[(j + 1) * cw + i]; const d = lat[(j + 1) * cw + i + 1];
      return (a * (1 - u) + b * u) * (1 - v) + (c * (1 - u) + d * u) * v;
    };
  }

  /*
   * The pictures are computed in a worker (shade-worker.js), one at a time: while one is running, only the
   * newest request waits, older ones are dropped (the day keeps playing). Without workers, on the page.
   */
  let shadeWorker = null;
  try { shadeWorker = new Worker('shade-worker.js'); } catch { shadeWorker = null; }
  const sentGrids = new Set();
  let frameId = 0;
  const pendingFrames = new Map();
  shadeWorker?.addEventListener('message', ({ data }) => {
    const p = pendingFrames.get(data.id);
    pendingFrames.delete(data.id);
    if (p) (data.error ? p.reject(new Error(data.error)) : p.resolve(data.lit));
  });
  shadeWorker?.addEventListener('error', () => {
    // E.g. blocked by the browser: compute on the page from now on.
    shadeWorker = null;
    for (const p of pendingFrames.values()) p.reject(new Error('Worker nicht verfügbar'));
    pendingFrames.clear();
  });
  let running = null; // the frame in the worker
  let waiting = null; // the newest frame asked for meanwhile
  function computeFrame(dem, surf, job) {
    if (!shadeWorker) return Promise.resolve(Shade.frame({ ...job, dem, surf }));
    const send = (task) => {
      if (!shadeWorker) { task.resolve(Shade.frame({ ...job, dem, surf })); return; }
      for (const g of [dem, surf]) {
        if (g && !sentGrids.has(g.key)) {
          shadeWorker.postMessage({ type: 'grid', key: g.key, grid: g.shared });
          sentGrids.add(g.key);
          if (sentGrids.size > 4) sentGrids.delete(sentGrids.values().next().value);
        }
      }
      const id = ++frameId;
      pendingFrames.set(id, task);
      shadeWorker.postMessage({ type: 'frame', id, dem: dem.key, surf: surf?.key, job });
    };
    return new Promise((resolve, reject) => {
      const task = { resolve, reject };
      const settle = (fn) => (v) => {
        fn(v);
        running = null;
        if (waiting) { const next = waiting; waiting = null; running = next; next.start(); }
      };
      task.start = () => send({ resolve: settle(resolve), reject: settle(reject) });
      if (running) {
        waiting?.reject(new Error('überholt'));
        waiting = task;
      } else {
        running = task;
        task.start();
      }
    });
  }

  const scheduleShade = () => {
    if (shadeFrame) return;
    shadeFrame = requestAnimationFrame(() => { shadeFrame = 0; drawShade(); });
  };

  async function drawShade() {
    const status = $('shade-status');
    if (!shadeOn() || !sm.date) {
      shadeOverlay?.remove();
      shadeOverlay = null;
      if (shadeUrl) URL.revokeObjectURL(shadeUrl);
      shadeUrl = null;
      status.hidden = true;
      return;
    }
    const token = ++shadeToken;
    const t = dayStart(sm.date) + sm.minute * 60000;
    const zoom = map.getZoom();
    const centre = map.getCenter();
    const sun = Sun.position(t, centre.lat, centre.lng);
    let grid = null;
    if (zoom >= SHADE_MIN_ZOOM && sun.altitude > 0) {
      try { grid = await loadDem(); } catch { grid = null; }
      if (token !== shadeToken || !shadeOn()) return;
    }
    // Trees and buildings: from map zoom 16 in Switzerland, once their heights are loaded.
    const wantSurface = Boolean(grid) && zoom >= SURFACE_MIN_ZOOM;
    const surf = wantSurface ? surfaceFor(grid) : null;
    const objects = surf && !surf.none ? surf : null;
    // Output cells: surface cells, DEM pixels of the view, or 8 screen pixels for night only.
    const z = objects ? objects.z : grid ? grid.z : zoom - 3;
    const s = 2 ** (z - zoom);
    const b = map.getPixelBounds();
    const x0 = Math.floor(b.min.x * s); const y0 = Math.floor(b.min.y * s);
    const w = Math.max(1, Math.ceil(b.max.x * s) - x0); const h = Math.max(1, Math.ceil(b.max.y * s) - y0);
    const latLngAt = (x, y) => map.unproject([x0 + x, y0 + y], z);
    const altAt = altitudeGrid(t, w, h, grid ? 32 : 8, latLngAt);
    let lit = null;
    if (grid) {
      // Terrain on the DEM cells of the view; trees and buildings on the finer grid, times the terrain's light.
      const sd = 2 ** (grid.z - zoom);
      const dx0 = Math.floor(b.min.x * sd); const dy0 = Math.floor(b.min.y * sd);
      const dw = Math.max(1, Math.ceil(b.max.x * sd) - dx0); const dh = Math.max(1, Math.ceil(b.max.y * sd) - dy0);
      const job = {
        altitude: sun.altitude, azimuth: sun.azimuth,
        terrain: { x0: dx0 - grid.tx0 * 256, y0: dy0 - grid.ty0 * 256, w: dw, h: dh, cellM: Shade.metresPerPixel(centre.lat, grid.z) },
        objects: objects ? {
          x0: x0 - objects.gx0, y0: y0 - objects.gy0, w, h, cellM: Shade.metresPerPixel(centre.lat, z), objectTop: objects.objectTop,
          f: 2 ** (grid.z - z), gx: x0, gy: y0, dx0, dy0,
        } : null,
      };
      try {
        lit = await computeFrame(grid, objects, job);
      } catch {
        return; // overtaken by a newer picture
      }
      // While the day plays, newer pictures are already asked for: show this one unless a newer one is on screen.
      if (token < shownToken || !shadeOn()) return;
    }
    const canvas = document.createElement('canvas');
    canvas.width = w; canvas.height = h;
    const ctx = canvas.getContext('2d');
    const img = ctx.createImageData(w, h);
    const px = img.data;
    let shaded = 0;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const k = y * w + x;
        let a = Shade.night(altAt(x + 0.5, y + 0.5)) * 0.62; // night: dark blue
        let r = 12; let g = 20; let bl = 40;
        if (lit) {
          const v = lit[k];
          if (v < 0.05) shaded++;
          if (v < 1) {
            a = Math.max(a, 0.42 * (1 - v)); r = 20; g = 32; bl = 58; // shadow, half shadow, slopes turned away
          } else if (v > 1.05 && a === 0) {
            a = Math.min(0.2, (v - 1) * 0.16); r = 255; g = 196; bl = 80; // steep in the sun: warm light
          }
        }
        px[k * 4] = r; px[k * 4 + 1] = g; px[k * 4 + 2] = bl; px[k * 4 + 3] = Math.round(a * 255);
      }
    }
    ctx.putImageData(img, 0, 0);
    const bounds = L.latLngBounds(latLngAt(0, 0), latLngAt(w, h));
    const blob = await new Promise((resolve) => canvas.toBlob(resolve));
    if (token < shownToken || !shadeOn() || !blob) return;
    shownToken = token;
    const url = URL.createObjectURL(blob);
    if (shadeUrl) URL.revokeObjectURL(shadeUrl);
    shadeUrl = url;
    if (shadeOverlay) shadeOverlay.setUrl(url).setBounds(bounds);
    else shadeOverlay = L.imageOverlay(url, bounds, { pane: 'sunshade', interactive: false }).addTo(map);

    const deg = (v) => `${fmtNum(Math.abs(v), 0)}°`;
    let text;
    if (sun.altitude <= -12) text = `Nacht – die Sonne steht ${deg(sun.altitude)} unter dem Horizont.`;
    else if (sun.altitude <= 0) text = `Dämmerung – die Sonne steht ${deg(sun.altitude)} unter dem Horizont.`;
    else if (!grid) text = zoom < SHADE_MIN_ZOOM ? 'Tag und Nacht; Schatten von Hügeln und Bergen ab näherem Zoom.' : 'Höhendaten nicht verfügbar, nur Tag und Nacht.';
    else {
      text = ` Schatten von Hügeln und Bergen bei Sonne ${deg(sun.altitude)} aus ${Sun.compass(sun.azimuth)}: ${Math.round((100 * shaded) / (w * h))} % der Karte im Schatten.`
        + ' Steil besonnte Hänge golden. Gelände aus dem Höhenmodell (~25 m);'
        + ` Berge bis ~${fmtNum((Shade.metresPerPixel(centre.lat, grid.z) * grid.far.scale * 256) / 1000, 0)} km ausserhalb des Ausschnitts zählen mit.`
        + (grid.missing ? ` ${grid.missing} von ${grid.total} Höhenkacheln fehlen.` : '');
      if (objects) {
        const from = [];
        if (objects.sources.has('swisstopo')) from.push('Bäume und Gebäude aus swissSURFACE3D (swisstopo)');
        const outside = [];
        if (objects.sources.has('meta')) outside.push('Baumkronen aus der Kronenhöhenkarte von Meta (1,2 m)');
        if (objects.sources.has('osm')) outside.push('Gebäude aus OpenStreetMap');
        if (outside.length) from.push(outside.join(' und ') + (objects.sources.has('osm') ? '' : ', ohne Gebäude'));
        text += ` Dazu ${from.join(', ausserhalb der Schweiz ') || 'Bäume und Gebäude'}.`
          + (objects.missing ? ` ${objects.missing} von ${objects.total} Kacheln fehlen.` : '');
      } else if (wantSurface && !surf) text += ' Bäume und Gebäude werden geladen …';
      else if (wantSurface) text += ' Bäume und Gebäude nicht verfügbar.';
      else text += ' Bäume und Gebäude ab näherem Zoom.';
    }
    status.hidden = false;
    status.replaceChildren(...(grid && sun.altitude > 0 ? [el('span', { class: 'shade-ramp', 'aria-hidden': 'true' })] : []), text);
  }
  $('shade-toggle').addEventListener('change', () => {
    try { localStorage.setItem('myforrest.shade', $('shade-toggle').checked ? '1' : '0'); } catch { /* private mode */ }
    drawShade();
  });
  try { $('shade-toggle').checked = localStorage.getItem('myforrest.shade') !== '0'; } catch { /* private mode */ }
  map.on('moveend', () => shadeOn() && drawShade());

  /* ---------- Weather maps: MeteoSwiss radar, maps of the Deutscher Wetterdienst ---------- */

  let dwdInfo = null;
  let dwdLayer = null;
  let chRadar = null; // /api/radar/ch?hours=24, refreshed every two minutes
  let chLayer = null;
  let chToken = 0;
  async function loadDwd() {
    if (dwdInfo) return;
    try {
      dwdInfo = await api('/api/dwd/layers');
    } catch {
      return;
    }
    const select = $('dwd-layer');
    let saved = '';
    try { saved = localStorage.getItem('myforrest.dwd') || ''; } catch { /* private mode */ }
    select.replaceChildren(
      el('option', { value: '', text: 'keine' }),
      ...(state.config.radarCh ? [el('option', { value: 'radar-ch', text: 'Radar MeteoSchweiz' })] : []),
      ...dwdInfo.layers.map((l) => el('option', { value: l.id, text: `${l.title} (DWD)` })),
    );
    if ([...select.options].some((o) => o.value === saved)) select.value = saved;
    drawDwd();
  }

  /**
   * The MeteoSwiss radar over the map: the picture at the chosen time while there is one (the last
   * 24 hours, every 5 minutes), otherwise the newest.
   */
  async function drawCh() {
    const status = $('dwd-status');
    const token = ++chToken;
    if (!chRadar || Date.now() - chRadar.at > 120000) {
      chRadar = { at: Date.now(), ...(await api('/api/radar/ch?hours=24').catch((err) => ({ frames: [], error: err.message }))) };
    }
    if (token !== chToken || $('dwd-layer').value !== 'radar-ch' || !sm.open) return;
    const frames = chRadar.frames || [];
    if (!frames.length) {
      chLayer?.remove();
      chLayer = null;
      status.hidden = false;
      status.textContent = `Radar der MeteoSchweiz nicht verfügbar${chRadar.error ? ` (${chRadar.error})` : ''}.`;
      return;
    }
    const t = dayStart(sm.date) + sm.minute * 60000;
    const at = frames.filter((f) => Date.parse(f.time) <= t + 150000 && Date.parse(f.time) > t - 600000).pop();
    const frame = at || frames[frames.length - 1];
    if (chLayer?._url !== frame.url) {
      const next = L.imageOverlay(frame.url, chRadar.bounds, {
        opacity: 0.7, pane: 'dwd', interactive: false, className: 'radar-img',
        attribution: '&copy; <a href="https://www.meteoschweiz.admin.ch/">MeteoSchweiz</a>',
      }).addTo(map);
      // Swap once the new picture is there, so moving the clock does not flicker.
      const old = chLayer;
      next.once('load', () => old?.remove());
      setTimeout(() => old?.remove(), 3000);
      chLayer = next;
    }
    status.hidden = false;
    status.textContent = `${at ? `Radarbild von ${clock(Date.parse(frame.time))}.`
      : `Neuestes Radarbild von ${clock(Date.parse(frame.time))} – Bilder gibt es für die letzten 24 Stunden.`} Schweiz mit Rand · Quelle: MeteoSchweiz`;
  }

  function drawDwd() {
    const status = $('dwd-status');
    if ($('dwd-layer').value === 'radar-ch' && sm.open && sm.date) {
      dwdLayer?.remove();
      dwdLayer = null;
      drawCh();
      return;
    }
    chToken += 1;
    chLayer?.remove();
    chLayer = null;
    const layer = dwdInfo?.layers.find((l) => l.id === $('dwd-layer').value);
    if (!sm.open || !layer || !sm.date) {
      dwdLayer?.remove();
      dwdLayer = null;
      status.hidden = true;
      return;
    }
    if (!dwdLayer || dwdLayer.wmsParams.layers !== layer.name) {
      dwdLayer?.remove();
      dwdLayer = L.tileLayer.wms(dwdInfo.url, {
        layers: layer.name, format: 'image/png', transparent: true, version: '1.3.0', opacity: 0.7, pane: 'dwd',
        attribution: `&copy; <a href="https://www.dwd.de/">${dwdInfo.attribution}</a>`,
      }).addTo(map);
    }
    // The radar shows the chosen time while DWD still has a picture of it, otherwise the newest one.
    const t = dayStart(sm.date) + sm.minute * 60000;
    let time = null;
    if (layer.from && t >= layer.from && t <= layer.to) {
      const step = (layer.stepMin || 5) * 60000;
      time = new Date(Math.floor(t / step) * step).toISOString();
    }
    if ((dwdLayer.wmsParams.time || null) !== time) {
      if (time) dwdLayer.wmsParams.time = time; else delete dwdLayer.wmsParams.time;
      dwdLayer.redraw();
    }
    const when = (v) => new Date(v).toLocaleString('de-CH', { day: 'numeric', month: 'numeric', hour: '2-digit', minute: '2-digit' });
    let text;
    if (layer.id === 'radar') {
      text = time ? `${Date.parse(time) > Date.now() ? 'Radarprognose für' : 'Radarbild von'} ${clock(Date.parse(time))}.`
        : `Neuestes Radarbild – für die gewählte Zeit hat der DWD keines${layer.from ? ` (vorhanden ${when(layer.from)} bis ${when(layer.to)})` : ''}.`;
    } else if (layer.id === 'warnungen') text = 'Aktuelle Warnungen, unabhängig von der gewählten Zeit.';
    else text = 'Aktuelle Karte des DWD.';
    status.hidden = false;
    status.textContent = `${text} Deutschland und Grenzgebiet · © ${dwdInfo.attribution}`;
  }
  $('dwd-layer').addEventListener('change', () => {
    try { localStorage.setItem('myforrest.dwd', $('dwd-layer').value); } catch { /* private mode */ }
    drawDwd();
  });

  /* ---------- Panel ---------- */

  function tile(label, value, sub) {
    return el('div', { class: 'wx-tile' }, [el('span', { text: label }), el('b', { text: value }), el('em', { text: sub || '' })]);
  }

  function weatherAt(t) {
    const h = sm.weather?.hourly || [];
    return h.find((x) => t >= x.t && t < x.t + 3600000) || null;
  }

  function renderPanel() {
    const p = place();
    const t = dayStart(sm.date) + sm.minute * 60000;
    $('sun-clock').textContent = clock(t);
    $('sun-place').textContent = `${p.label} · ${p.lat.toFixed(4)}, ${p.lon.toFixed(4)}` +
      (p.exposition && p.exposition !== 'eben' ? ` · ${p.exposition}, ${Math.round(p.slope)}°` : '');
    const sun = Sun.position(t, p.lat, p.lon);
    const slopeOk = Number.isFinite(p.slope) && p.slope >= 3;
    const behind = behindAt(sun);
    const horizonHere = Math.max(0, Sun.horizonAt(sm.horizon, sun.azimuth));
    // Clear-sky values at this minute, with terrain when the horizon is known.
    const cur = Sun.at(t, p.lat, p.lon, { elevation: p.elevation || 0, slope: p.slope || 0, aspect: p.aspect ?? 180, horizon: sm.horizon });
    const wx = weatherAt(t);
    const shadow = sun.altitude > 0 && !behind ? TREE_HEIGHT / Math.tan((sun.altitude * Math.PI) / 180) : null;
    const rg = ridge();

    const irrSub = [];
    if (slopeOk) irrSub.push(`am Hang ${Math.round(cur.slopeTerrain)} W/m²`);
    if (sm.horizon?.angles && Math.round(cur.ghi) !== Math.round(cur.ghiTerrain)) irrSub.push(`ohne Gelände ${Math.round(cur.ghi)}`);
    $('sun-tiles').replaceChildren(
      tile('Sonnenstand', sun.altitude > 0 ? `${fmtNum(sun.altitude, 1)}° hoch` : 'unter dem Horizont',
        `Richtung ${Math.round(sun.azimuth)}° (${Sun.compass(sun.azimuth)})${behind ? ` · hinter dem Gelände (${fmtNum(horizonHere, 0)}°)` : ''}`),
      tile('Einstrahlung klar', `${Math.round(cur.ghiTerrain)} W/m²`, irrSub.length ? irrSub.join(' · ') : 'auf ebenem Boden'),
      tile(sm.weather?.source === 'forecast' ? 'Prognose' : 'Gemessen',
        wx && Number.isFinite(wx.radiation) ? `${Math.round(wx.radiation)} W/m²` : '–',
        wx ? `${Number.isFinite(wx.precip) ? `${fmtNum(wx.precip, 1)} mm Regen` : ''}${Number.isFinite(wx.cloud) ? ` · ${wx.cloud} % bewölkt` : ''}` : 'keine Wetterdaten für diesen Tag'),
      behind
        ? tile(`Schatten ${TREE_HEIGHT}-m-Baum`, 'Geländeschatten', 'der ganze Ort liegt im Schatten')
        : tile(`Schatten ${TREE_HEIGHT}-m-Baum`, shadow !== null ? (shadow > 999 ? '> 1 km' : `${Math.round(shadow)} m`) : '–',
          shadow !== null ? `nach ${Sun.compass((sun.azimuth + 180) % 360)}` : ''),
      tile('Himmelssicht', rg ? `${fmtNum(sm.horizon.svf * 100, 0)} %` : (sm.horizonError ? 'nicht verfügbar' : 'wird berechnet …'),
        rg ? (rg.angle >= 1 ? `höchster Grat ${fmtNum(rg.angle, 0)}° im ${Sun.compass(rg.azimuth)}${rg.distance ? `, ${rg.distance >= 1000 ? `${fmtNum(rg.distance / 1000, 1)} km` : `${rg.distance} m`}` : ''}` : 'freier Horizont')
          : 'ohne Geländeschatten gerechnet'),
    );

    const d = sm.day;
    const len = d.sunrise !== null && d.sunset !== null ? (d.sunset - d.sunrise) / 60000 : null;
    const parts = [];
    if (d.sunrise !== null) parts.push(['Aufgang', clock(d.sunrise)]);
    if (d.sunset !== null) parts.push(['Untergang', clock(d.sunset)]);
    if (len !== null) parts.push(['Tageslänge', `${Math.floor(len / 60)} h ${pad(Math.round(len % 60))} min`]);
    parts.push(['Höchststand', `${fmtNum(d.maxAltitude, 1)}°`]);
    const hm = (min) => (min < 60 ? `${Math.round(min)} min` : `${Math.floor(min / 60)} h ${pad(Math.round(min % 60))} min`);
    if (sm.horizon?.angles) {
      parts.push(['Sonne über Gelände', d.periods.length ? d.periods.map((q) => `${clock(q.from)}–${clock(q.to)}`).join(', ') : 'gar nicht']);
      const lost = (len ?? 0) - d.sunMinutes;
      parts.push(['Sonnenstunden', `${hm(d.sunMinutes)}${lost > 2 ? ` (−${hm(lost)} durch Gelände)` : ''}`]);
    }
    parts.push(['Tagessumme klar', `${fmtNum(d.totalFlatTerrain, 1)} kWh/m²${slopeOk ? ` (Hang ${fmtNum(d.totalSlopeTerrain, 1)})` : ''}` +
      (sm.horizon?.angles && fmtNum(d.totalFlat, 1) !== fmtNum(d.totalFlatTerrain, 1) ? `, ohne Gelände ${fmtNum(d.totalFlat, 1)}` : '')]);
    const tot = sm.weather?.totals;
    if (tot?.radiationKwh != null) parts.push([sm.weather.source === 'forecast' ? 'Prognose' : 'Gemessen', `${fmtNum(tot.radiationKwh, 1)} kWh/m²`]);
    if (tot?.precip != null) parts.push(['Regen', `${fmtNum(tot.precip, 1)} mm`]);
    if (tot?.tmin != null) parts.push(['Temperatur', `${fmtNum(tot.tmin, 0)}–${fmtNum(tot.tmax, 0)} °C`]);
    $('sun-dayline').replaceChildren(...parts.flatMap(([k, v], i) => [i ? ' · ' : '', `${k} `, el('b', { text: v })]));

    const horizonNote = sm.horizon?.angles
      ? ' · Horizont aus dem Copernicus-Höhenmodell (36 Richtungen bis 20 km, ohne Bäume und Gebäude)'
      : (sm.horizonError ? ` · Horizont nicht verfügbar (${sm.horizonError}), ohne Geländeschatten gerechnet` : '');
    $('sun-source').textContent = (sm.weather?.source
      ? `Sonnenstand berechnet; ${sm.weather.source === 'archive' ? 'Messdaten (ERA5-Reanalyse)' : 'Prognose'}: Open-Meteo.com`
      : `Sonnenstand und Einstrahlung bei klarem Himmel berechnet${sm.weather?.error ? ` · Wetterdaten nicht verfügbar (${sm.weather.error})` : ' · für diesen Tag gibt es keine Wetterdaten'}`) + horizonNote;
  }

  /* ---------- Charts: irradiance (W/m²) and rain (mm/h), same time axis ---------- */

  const SVG = 'http://www.w3.org/2000/svg';
  const sv = (tag, attrs = {}, children = []) => {
    const n = document.createElementNS(SVG, tag);
    for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, String(v));
    n.append(...children);
    return n;
  };
  const W = 360; const LEFT = 30; const RIGHT = 6;
  const xOf = (minute) => LEFT + ((W - LEFT - RIGHT) * minute) / 1440;

  function chartFrame(title, legend, height, maxY, unit) {
    const wrap = el('div', { class: 'sun-chart' });
    const tip = el('div', { class: 'wx-tip', hidden: '' });
    const top = 8; const bottom = 18;
    const y = (v) => top + (height - top - bottom) * (1 - v / maxY);
    const nodes = [
      sv('line', { class: 'grid', x1: LEFT, x2: W - RIGHT, y1: y(0), y2: y(0) }),
      sv('line', { class: 'grid', x1: LEFT, x2: W - RIGHT, y1: y(maxY / 2), y2: y(maxY / 2), 'stroke-dasharray': '2 3' }),
      sv('text', { class: 'axis', x: LEFT - 4, y: y(maxY) + 3, 'text-anchor': 'end' }, [String(maxY)]),
      sv('text', { class: 'axis', x: LEFT - 4, y: y(0) + 3, 'text-anchor': 'end' }, ['0']),
      ...[0, 6, 12, 18, 24].map((hr) => sv('text', { class: 'axis', x: xOf(hr * 60), y: height - 4, 'text-anchor': 'middle' }, [`${hr}`])),
    ];
    wrap.append(el('h4', { text: `${title} (${unit})` }), el('div', { class: 'wx-legend' }, legend));
    return { wrap, tip, nodes, y, height };
  }

  function renderCharts() {
    const p = place();
    const d = sm.day;
    const slopeOk = Number.isFinite(p.slope) && p.slope >= 3;
    const hourly = (sm.weather?.hourly || []).map((h) => ({ ...h, minute: (h.t - dayStart(sm.date)) / 60000 }))
      .filter((h) => h.minute >= 0 && h.minute < 1440);
    const terrain = Boolean(sm.horizon?.angles);
    const maxRad = Math.max(200, ...d.samples.map((s) => Math.max(s.ghi, slopeOk ? s.slopeTerrain : 0)), ...hourly.map((h) => h.radiation || 0));
    const niceRad = Math.ceil(maxRad / 200) * 200;
    const anyBehind = terrain && d.samples.some((s) => s.behind);

    const legend = [el('span', {}, [el('i', { style: 'background: var(--sun)' }), terrain ? 'klarer Himmel mit Gelände' : 'klarer Himmel'])];
    if (anyBehind) {
      legend.push(el('span', {}, [el('i', { class: 'dot' }), 'ohne Gelände']));
      legend.push(el('span', {}, [el('i', { class: 'behind' }), 'Sonne hinter Gelände']));
    }
    if (slopeOk) legend.push(el('span', {}, [el('i', { class: 'dash' }), `klar am Hang (${p.exposition})`]));
    if (hourly.some((h) => Number.isFinite(h.radiation))) {
      legend.push(el('span', {}, [el('i', { style: 'background: var(--measured)' }), sm.weather.source === 'forecast' ? 'Prognose' : 'gemessen']));
    }
    const rad = chartFrame('Sonneneinstrahlung', legend, 150, niceRad, 'W/m²');
    const pts = (key) => d.samples.map((s) => `${xOf(s.minute).toFixed(1)},${rad.y(s[key]).toFixed(1)}`).join(' ');
    if (anyBehind) {
      // Bands where the sun is up but behind the terrain.
      for (const s of d.samples) {
        if (!s.behind || s.minute >= 1440) continue;
        rad.nodes.push(sv('rect', { class: 'behind', x: xOf(s.minute).toFixed(1), y: 4, width: (xOf(s.minute + 10) - xOf(s.minute) + 0.4).toFixed(1), height: (rad.y(0) - 4).toFixed(1) }));
      }
    }
    rad.nodes.push(sv('polygon', { class: 'clear', points: `${xOf(0)},${rad.y(0)} ${pts('ghiTerrain')} ${xOf(1440)},${rad.y(0)}` }));
    if (anyBehind) rad.nodes.push(sv('polyline', { class: 'clear-open', points: pts('ghi') }));
    if (slopeOk) rad.nodes.push(sv('polyline', { class: 'clear-slope', points: pts('slopeTerrain') }));
    const measured = hourly.filter((h) => Number.isFinite(h.radiation));
    if (measured.length) {
      // Hourly means are drawn at the middle of their hour.
      rad.nodes.push(sv('polyline', { class: 'measured', points: measured.map((h) => `${xOf(h.minute + 30).toFixed(1)},${rad.y(h.radiation).toFixed(1)}`).join(' ') }));
    }
    const charts = [rad];

    const rainy = hourly.filter((h) => Number.isFinite(h.precip));
    if (rainy.length) {
      const maxRain = Math.max(1, ...rainy.map((h) => h.precip));
      const niceRain = maxRain <= 2 ? 2 : Math.ceil(maxRain / 2) * 2;
      const rain = chartFrame('Regen pro Stunde', [el('span', {}, [el('i', { style: 'background: var(--wet)' }), `${fmtNum(sm.weather.totals.precip ?? 0, 1)} mm am Tag`])], 90, niceRain, 'mm');
      const bw = (W - LEFT - RIGHT) / 24 - 2;
      for (const h of rainy) {
        if (h.precip <= 0) continue;
        const x0 = xOf(h.minute) + 1; const yTop = rain.y(h.precip); const yb = rain.y(0); const r = Math.min(3, (yb - yTop), bw / 2);
        rain.nodes.push(sv('path', { class: 'rain', d: `M${x0} ${yb}V${yTop + r}Q${x0} ${yTop} ${x0 + r} ${yTop}H${x0 + bw - r}Q${x0 + bw} ${yTop} ${x0 + bw} ${yTop + r}V${yb}Z` }));
      }
      charts.push(rain);
    }

    // Shared: marker for the chosen time, crosshair + tooltip on hover, click/drag sets the time.
    for (const c of charts) {
      const now = sv('line', { class: 'now', x1: xOf(sm.minute), x2: xOf(sm.minute), y1: 4, y2: c.y(0) });
      const cross = sv('line', { class: 'cross', x1: 0, x2: 0, y1: 4, y2: c.y(0), visibility: 'hidden' });
      const hit = sv('rect', { class: 'hit', x: LEFT, y: 0, width: W - LEFT - RIGHT, height: c.height, tabindex: 0, 'aria-label': 'Zeitpunkt im Diagramm wählen' });
      const svg = sv('svg', { viewBox: `0 0 ${W} ${c.height}`, role: 'img', 'aria-label': c.wrap.querySelector('h4').textContent }, [...c.nodes, now, cross, hit]);
      const minuteAt = (evt) => {
        const r = svg.getBoundingClientRect();
        const x = ((evt.clientX - r.left) / r.width) * W;
        return Math.max(0, Math.min(1439, Math.round((((x - LEFT) / (W - LEFT - RIGHT)) * 1440) / 5) * 5));
      };
      const show = (minute, evt) => {
        cross.setAttribute('x1', xOf(minute)); cross.setAttribute('x2', xOf(minute)); cross.setAttribute('visibility', 'visible');
        const t = dayStart(sm.date) + minute * 60000;
        const s = Sun.position(t, p.lat, p.lon);
        const cur = Sun.at(t, p.lat, p.lon, { elevation: p.elevation || 0, horizon: sm.horizon });
        const w = weatherAt(t);
        const lines = [`Sonne ${s.altitude > 0 ? `${fmtNum(s.altitude, 0)}°${cur.behind ? ' hinter Gelände' : ''}` : 'unter Horizont'} · klar ${Math.round(cur.ghiTerrain)} W/m²`];
        if (w && Number.isFinite(w.radiation)) lines.push(`${sm.weather.source === 'forecast' ? 'Prognose' : 'gemessen'} ${Math.round(w.radiation)} W/m²`);
        if (w && Number.isFinite(w.precip)) lines.push(`Regen ${fmtNum(w.precip, 1)} mm/h`);
        c.tip.replaceChildren(el('strong', { text: clock(t) }), ...lines.flatMap((l, i) => (i ? [el('br'), l] : [l])));
        c.tip.hidden = false;
        const box = c.wrap.getBoundingClientRect();
        const half = c.tip.offsetWidth / 2 + 4;
        c.tip.style.left = `${Math.min(Math.max(evt.clientX - box.left, half), box.width - half)}px`;
        c.tip.style.top = `${svg.getBoundingClientRect().top - box.top + 14}px`;
      };
      hit.addEventListener('pointermove', (evt) => {
        show(minuteAt(evt), evt);
        if (evt.buttons === 1) setMinute(minuteAt(evt));
      });
      hit.addEventListener('pointerdown', (evt) => setMinute(minuteAt(evt)));
      hit.addEventListener('pointerleave', () => { c.tip.hidden = true; cross.setAttribute('visibility', 'hidden'); });
      hit.addEventListener('keydown', (evt) => {
        if (evt.key === 'ArrowRight') { setMinute(Math.min(1439, sm.minute + 10)); evt.preventDefault(); }
        if (evt.key === 'ArrowLeft') { setMinute(Math.max(0, sm.minute - 10)); evt.preventDefault(); }
      });
      c.wrap.append(svg, c.tip);
    }
    // Screen-reader table with the hourly values.
    const table = el('div', { class: 'sr-only' }, el('table', {}, [
      el('caption', { text: `Stundenwerte am ${sm.date}` }),
      el('tr', {}, ['Stunde', 'klar ohne Gelände (W/m²)', 'klar mit Gelände (W/m²)', 'gemessen (W/m²)', 'Regen (mm)'].map((h) => el('th', { text: h }))),
      ...Array.from({ length: 24 }, (_, hr) => {
        const s = d.samples.find((x) => x.minute === hr * 60 + 30) || d.samples[hr * 6];
        const w = hourly.find((h) => Math.round(h.minute / 60) === hr);
        return el('tr', {}, [String(hr), String(Math.round(s.ghi)), String(Math.round(s.ghiTerrain)), w?.radiation ?? '–', w?.precip ?? '–'].map((v) => el('td', { text: String(v) })));
      }),
    ]));
    $('sun-charts').replaceChildren(...charts.map((c) => c.wrap), table);
  }

  /* ---------- State changes ---------- */

  function setMinute(minute) {
    sm.minute = minute;
    $('sun-slider').value = String(minute);
    renderPanel();
    drawMap();
    if (shadeOn()) scheduleShade();
    drawDwd();
    if (coolOn()) drawCool(); // another season or time of day, or only new tooltips
    for (const line of document.querySelectorAll('#sun-charts .now')) {
      line.setAttribute('x1', xOf(minute));
      line.setAttribute('x2', xOf(minute));
    }
  }

  async function load() {
    if (!sm.open) return;
    const p = place();
    const token = ++sm.loadToken;
    const computeDay = () => {
      sm.day = Sun.day(dayStart(sm.date), p.lat, p.lon, { elevation: p.elevation || 0, slope: p.slope || 0, aspect: p.aspect ?? 180, stepMin: 10, horizon: sm.horizon });
    };
    const placeKeyNow = `${p.lat.toFixed(3)},${p.lon.toFixed(3)}`;
    if (sm.horizonFor !== placeKeyNow) { sm.horizon = null; sm.horizonError = null; }
    computeDay();
    sm.weather = null;
    renderPanel();
    renderCharts();
    drawMap();
    drawRain();
    drawShade();
    drawDwd();
    if (sm.horizonFor !== placeKeyNow) {
      fetchHorizon(p).then((h) => {
        if (token !== sm.loadToken) return;
        sm.horizonFor = placeKeyNow;
        sm.horizon = h.angles ? h : null;
        sm.horizonError = h.angles ? null : (h.error || 'unbekannter Fehler');
        computeDay();
        renderPanel();
        renderCharts();
        drawMap();
      });
    }
    try {
      const q = `lat=${p.lat.toFixed(4)}&lon=${p.lon.toFixed(4)}&date=${sm.date}${Number.isFinite(p.elevation) ? `&elevation=${Math.round(p.elevation)}` : ''}`;
      const wx = await api(`/api/weather/day?${q}`);
      if (token !== sm.loadToken) return;
      sm.weather = wx;
      renderPanel();
      renderCharts();
      if (coolOn()) drawCool(); // model air temperature for the tooltips
    } catch {
      // Panel already shows the astronomical part.
    }
  }

  function setDate(date) {
    sm.date = date;
    $('sun-date').value = date;
    load();
  }

  function toggle(open) {
    sm.open = open;
    $('sunpanel').hidden = !open;
    $('sun-toggle').setAttribute('aria-expanded', String(open));
    if (open) {
      sunLayer.addTo(map);
      rainLayer.addTo(map);
      coolLayer.addTo(map);
      drawCool();
      loadDwd();
      if (!sm.date) {
        const now = new Date();
        sm.minute = Math.floor((now.getHours() * 60 + now.getMinutes()) / 5) * 5;
        $('sun-slider').value = String(sm.minute);
        setDate(isoLocal(now));
      } else {
        load();
      }
    } else {
      stop();
      sunLayer.remove();
      rainLayer.remove();
      coolLayer.remove();
      drawCool();
      drawShade();
      drawDwd();
    }
  }

  function stop() {
    clearInterval(sm.playing);
    sm.playing = null;
    $('sun-play').textContent = '▶';
    $('sun-play').setAttribute('aria-label', 'Tagesverlauf abspielen');
  }

  $('sun-toggle').addEventListener('click', () => toggle(!sm.open));
  $('sun-close').addEventListener('click', () => toggle(false));
  $('sun-slider').addEventListener('input', (e) => setMinute(Number(e.target.value)));
  $('sun-date').addEventListener('change', (e) => e.target.value && setDate(e.target.value));
  const shiftDay = (n) => {
    const d = new Date(`${sm.date}T12:00:00`);
    d.setDate(d.getDate() + n);
    setDate(isoLocal(d));
  };
  $('sun-prev').addEventListener('click', () => shiftDay(-1));
  $('sun-next').addEventListener('click', () => shiftDay(1));
  $('sun-today').addEventListener('click', () => setDate(isoLocal(new Date())));
  $('sun-play').addEventListener('click', () => {
    if (sm.playing) return stop();
    $('sun-play').textContent = '❚❚';
    $('sun-play').setAttribute('aria-label', 'Anhalten');
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    sm.playing = setInterval(() => setMinute((sm.minute + (reduce ? 60 : 10)) % 1440), reduce ? 600 : 90);
  });

  // Follow the place: spot opened or closed, map moved without a spot, zoom changes the ring size.
  let lastPlace = '';
  const placeKey = () => { const p = place(); return `${p.label}:${p.lat.toFixed(3)},${p.lon.toFixed(3)}:${p.slope}:${p.aspect}`; };
  const refreshPlace = () => {
    if (!sm.open) return;
    const k = placeKey();
    if (k !== lastPlace) { lastPlace = k; load(); } else drawMap();
  };
  map.on('moveend zoomend', refreshPlace);
  // Elevation and surface tiles for the sun and shade along a route (tours.js), from the same caches.
  window.ShadeTiles = { dem: demTile, surface: surfaceTile };
  new MutationObserver(refreshPlace).observe($('spot'), { attributes: true, attributeFilter: ['hidden'] });
  new MutationObserver(refreshPlace).observe($('spot-elev-text'), { childList: true, characterData: true, subtree: true });
}());
